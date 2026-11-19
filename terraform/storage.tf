locals {
  use_cli_s3_buckets            = coalesce(var.manage_s3_with_cli, local.is_lab && var.use_lab_role)
  assets_bucket_desired_name    = "${local.name_prefix}-assets-${random_id.suffix.hex}"
  imports_bucket_desired_name   = "${local.name_prefix}-imports-${random_id.suffix.hex}"
  assets_bucket_name            = local.use_cli_s3_buckets ? terraform_data.lab_s3_buckets[0].output.assets_bucket : aws_s3_bucket.assets[0].id
  imports_bucket_name           = local.use_cli_s3_buckets ? terraform_data.lab_s3_buckets[0].output.imports_bucket : aws_s3_bucket.imports[0].id
  assets_bucket_arn             = local.use_cli_s3_buckets ? "arn:aws:s3:::${local.assets_bucket_name}" : aws_s3_bucket.assets[0].arn
  imports_bucket_arn            = local.use_cli_s3_buckets ? "arn:aws:s3:::${local.imports_bucket_name}" : aws_s3_bucket.imports[0].arn
  assets_bucket_regional_domain = local.use_cli_s3_buckets ? "${local.assets_bucket_name}.s3.${var.aws_region}.amazonaws.com" : aws_s3_bucket.assets[0].bucket_regional_domain_name
  assets_website_endpoint       = aws_s3_bucket_website_configuration.assets.website_endpoint
}

moved {
  from = aws_s3_bucket.assets
  to   = aws_s3_bucket.assets[0]
}

moved {
  from = aws_s3_bucket.imports
  to   = aws_s3_bucket.imports[0]
}

# En AWS Academy Learner Lab, la SCP niega s3:GetBucketObjectLockConfiguration (que el provider
# aws consulta al leer/crear cualquier aws_s3_bucket). En ese entorno se crean/destruyen vía AWS CLI.
resource "terraform_data" "lab_s3_buckets" {
  count = local.use_cli_s3_buckets ? 1 : 0

  triggers_replace = [
    local.assets_bucket_desired_name,
    local.imports_bucket_desired_name,
    var.aws_region,
  ]

  input = {
    assets_bucket  = local.assets_bucket_desired_name
    imports_bucket = local.imports_bucket_desired_name
    region         = var.aws_region
    script         = "${path.module}/scripts/lab-s3-buckets.mjs"
  }

  provisioner "local-exec" {
    command = "node ${self.input.script} create ${self.input.assets_bucket} ${self.input.imports_bucket} ${self.input.region}"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "node ${self.input.script} destroy ${self.input.assets_bucket} ${self.input.imports_bucket} ${self.input.region}"
  }
}

# Bucket para consolas web, shell estático de invitación (/invitacion/#t=...) y QR PNGs (NFR-02)
resource "aws_s3_bucket" "assets" {
  count = local.use_cli_s3_buckets ? 0 : 1

  bucket        = local.assets_bucket_desired_name
  force_destroy = local.is_lab
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = local.assets_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_website_configuration" "assets" {
  bucket = local.assets_bucket_name

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket = local.assets_bucket_name

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = var.enable_cloudfront
  restrict_public_buckets = var.enable_cloudfront
}

resource "aws_s3_bucket_cors_configuration" "assets" {
  bucket = local.assets_bucket_name

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_policy" "assets_cloudfront" {
  count  = var.enable_cloudfront ? 1 : 0
  bucket = local.assets_bucket_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${local.assets_bucket_arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.edge[0].arn
          }
        }
      }
    ]
  })
}

resource "aws_s3_bucket_policy" "assets_lab_website" {
  count  = var.enable_cloudfront ? 0 : 1
  bucket = local.assets_bucket_name

  depends_on = [aws_s3_bucket_public_access_block.assets]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowPublicReadStaticAndQRInLab"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${local.assets_bucket_arn}/*"
      }
    ]
  })
}

# Bucket privado para archivos CSV de importación masiva (RF-02, <= 20 000 filas)
resource "aws_s3_bucket" "imports" {
  count = local.use_cli_s3_buckets ? 0 : 1

  bucket        = local.imports_bucket_desired_name
  force_destroy = local.is_lab
}

resource "aws_s3_bucket_server_side_encryption_configuration" "imports" {
  bucket = local.imports_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "imports" {
  bucket = local.imports_bucket_name

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "imports" {
  bucket = local.imports_bucket_name

  rule {
    id     = "expire-import-csvs"
    status = "Enabled"

    filter {
      prefix = "imports/"
    }

    expiration {
      days = 7
    }
  }
}

# CloudFront condicional (enable_cloudfront = true en producción; false en Learner Lab)
resource "aws_cloudfront_origin_access_control" "assets" {
  count                             = var.enable_cloudfront ? 1 : 0
  name                              = "${local.name_prefix}-assets-oac-${random_id.suffix.hex}"
  description                       = "OAC para bucket de estáticos y QR PNG de Orquesta"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Rutas del SPA (/invitacion/, /planner/…) no existen como archivos en S3: sin esto CloudFront
# devuelve 403 y el enlace de la invitación no abre. Solo aplica al origen S3, nunca a /v1/*.
resource "aws_cloudfront_function" "spa_rewrite" {
  count   = var.enable_cloudfront ? 1 : 0
  name    = "${local.name_prefix}-spa-${random_id.suffix.hex}"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var req = event.request;
      // Archivos con extensión (.js, .css, .png, .webmanifest) pasan tal cual; lo demás es una ruta de Angular.
      if (!/\.[a-zA-Z0-9]+$/.test(req.uri)) {
        req.uri = '/index.html';
      }
      return req;
    }
  EOT
}

# Política administrada de AWS: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy.
data "aws_cloudfront_response_headers_policy" "security" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "edge" {
  count               = var.enable_cloudfront ? 1 : 0
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  comment             = "Orquesta Edge CDN (NFR-02)"

  origin {
    domain_name              = local.assets_bucket_regional_domain
    origin_id                = "s3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets[0].id
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.http_api.api_endpoint, "https://", "")
    origin_id   = "apigw-v1"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "s3-assets"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security[0].id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite[0].arn
    }

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 300
    max_ttl     = 86400
  }

  ordered_cache_behavior {
    path_pattern               = "/v1/*"
    target_origin_id           = "apigw-v1"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security[0].id

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Origin", "Access-Control-Request-Headers", "Access-Control-Request-Method"]
      cookies {
        forward = "all"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # CloudFront guarda los errores 10 s por defecto: un 503 por un pico se repetiría a todos los
  # usuarios y un 404 ocultaría un recurso recién creado. Errores sin caché.
  dynamic "custom_error_response" {
    for_each = [404, 500, 502, 503, 504]
    content {
      error_code            = custom_error_response.value
      error_caching_min_ttl = 0
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  aliases    = local.use_domain ? [var.custom_domain] : []
  web_acl_id = local.waf_enabled ? aws_wafv2_web_acl.edge[0].arn : null

  viewer_certificate {
    cloudfront_default_certificate = local.use_domain ? null : true
    acm_certificate_arn            = local.use_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = local.use_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}

locals {
  frontend_dist_dir = "${path.module}/../front/dist/orquesta/browser"
  mime_types = {
    ".html"        = "text/html; charset=utf-8"
    ".js"          = "application/javascript; charset=utf-8"
    ".mjs"         = "application/javascript; charset=utf-8"
    ".css"         = "text/css; charset=utf-8"
    ".json"        = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json"
    ".svg"         = "image/svg+xml"
    ".png"         = "image/png"
    ".ico"         = "image/x-icon"
    ".txt"         = "text/plain; charset=utf-8"
    ".woff2"       = "font/woff2"
  }
  frontend_files = toset([
    for f in fileset(local.frontend_dist_dir, "**/*") : f
    if f != "runtime-config.js"
  ])
}

resource "aws_s3_object" "frontend_assets" {
  for_each = local.frontend_files

  bucket = local.assets_bucket_name
  key    = each.value
  source = "${local.frontend_dist_dir}/${each.value}"
  etag   = filemd5("${local.frontend_dist_dir}/${each.value}")
  content_type = lookup(
    local.mime_types,
    lower(try(regex("\\.[^.]+$", each.value), "")),
    "application/octet-stream"
  )
  cache_control = contains(
    ["index.html", "index.csr.html", "ngsw.json", "ngsw-worker.js", "safety-worker.js", "manifest.webmanifest"],
    basename(each.value)
  ) ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable"
}

resource "aws_s3_object" "runtime_config" {
  bucket        = local.assets_bucket_name
  key           = "runtime-config.js"
  content       = "window.__ORQUESTA_API__ = { baseUrl: ${jsonencode(var.enable_cloudfront ? "" : aws_apigatewayv2_api.http_api.api_endpoint)} };\n"
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache, no-store, must-revalidate"
}
