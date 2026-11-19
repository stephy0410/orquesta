# Dominio propio (opcional): HTTPS con certificado ACM en CloudFront, registros DNS en Route 53 y
# autenticación del correo saliente con SES (SPF, DKIM y DMARC, README FR8).
#
# Se activa con custom_domain + route53_zone_id + enable_cloudfront = true. En Learner Lab queda
# apagado (CloudFront y SES están bloqueados por la política Pvoclabs).
#
# CloudFront sirve el front y enruta /v1/* al API desde el mismo origen, así que basta un solo
# nombre (sin dominio propio en API Gateway ni CORS cruzado).

locals {
  use_domain      = var.custom_domain != "" && var.enable_cloudfront
  use_ses_domain  = local.use_domain && var.email_provider_mode == "ses"
  public_base_url = local.use_domain ? "https://${var.custom_domain}" : (var.enable_cloudfront ? "https://${aws_cloudfront_distribution.edge[0].domain_name}" : "http://${local.assets_website_endpoint}")
  email_from = (local.use_domain ? "Orquesta <${var.email_from_local_part}@${var.custom_domain}>"
  : var.ses_sender_email != "" ? "Orquesta <${var.ses_sender_email}>" : "Orquesta <no-reply@orquesta.local>")
  use_ses_sender = !local.use_domain && var.email_provider_mode == "ses" && var.ses_sender_email != ""
}

resource "aws_acm_certificate" "site" {
  count             = local.use_domain ? 1 : 0
  domain_name       = var.custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = var.aws_region == "us-east-1"
      error_message = "CloudFront solo acepta certificados ACM de us-east-1."
    }
    precondition {
      condition     = var.route53_zone_id != ""
      error_message = "custom_domain requiere route53_zone_id para validar el certificado y crear los registros."
    }
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.use_domain ? {
    for o in aws_acm_certificate.site[0].domain_validation_options : o.domain_name => o
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  count                   = local.use_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "site_alias" {
  for_each = local.use_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.edge[0].domain_name
    zone_id                = aws_cloudfront_distribution.edge[0].hosted_zone_id
    evaluate_target_health = false
  }
}

# --- Correo saliente autenticado (SES) ----------------------------------------
resource "aws_ses_domain_identity" "mail" {
  count  = local.use_ses_domain ? 1 : 0
  domain = var.custom_domain
}

resource "aws_route53_record" "ses_verification" {
  count   = local.use_ses_domain ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "_amazonses.${var.custom_domain}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.mail[0].verification_token]
}

resource "aws_ses_domain_dkim" "mail" {
  count  = local.use_ses_domain ? 1 : 0
  domain = aws_ses_domain_identity.mail[0].domain
}

resource "aws_route53_record" "ses_dkim" {
  count   = local.use_ses_domain ? 3 : 0
  zone_id = var.route53_zone_id
  name    = "${aws_ses_domain_dkim.mail[0].dkim_tokens[count.index]}._domainkey.${var.custom_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.mail[0].dkim_tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "spf" {
  count   = local.use_ses_domain ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  count   = local.use_ses_domain ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.custom_domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=quarantine; rua=mailto:dmarc@${var.custom_domain}; adkim=s; aspf=s"]
}

resource "aws_ses_domain_identity_verification" "mail" {
  count      = local.use_ses_domain ? 1 : 0
  domain     = aws_ses_domain_identity.mail[0].id
  depends_on = [aws_route53_record.ses_verification]
}

# Sin dominio propio: SES envía desde un correo verificado (le llega un enlace de confirmación).
resource "aws_sesv2_email_identity" "sender" {
  count          = local.use_ses_sender ? 1 : 0
  email_identity = var.ses_sender_email
}
