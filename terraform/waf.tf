# AWS WAF en CloudFront (README: "los clientes entran por CloudFront con WAF").
#
# - Reglas administradas de AWS (OWASP comunes y entradas maliciosas conocidas).
# - Límite de peticiones por IP para frenar fuerza bruta en /v1/auth/* y scraping.
# - SizeRestrictions_BODY en modo COUNT: la regla común bloquea cuerpos > 8 KB y rompería el import
#   de CSV (hasta 20 000 filas) y los lotes de check-in (hasta 500 escaneos). El tamaño ya lo
#   limitan API Gateway y la validación del API (413 BATCH_TOO_LARGE / IMPORT_FILAS_EXCEDIDAS).
#
# Scope CLOUDFRONT: el Web ACL debe vivir en us-east-1.

locals {
  waf_enabled = var.enable_waf && var.enable_cloudfront
}

resource "aws_wafv2_web_acl" "edge" {
  count       = local.waf_enabled ? 1 : 0
  name        = "${local.name_prefix}-edge"
  description = "Orquesta: reglas administradas + rate limit por IP"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-por-ip"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-por-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-edge"
    sampled_requests_enabled   = true
  }

  lifecycle {
    precondition {
      condition     = var.aws_region == "us-east-1"
      error_message = "Un Web ACL de scope CLOUDFRONT debe crearse en us-east-1."
    }
  }
}
