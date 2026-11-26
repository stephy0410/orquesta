"""Diagrama de System Design de Orquesta en AWS.

Refleja solo lo que está desplegado en la demo (workspace `personal` de
`terraform/`, cuenta propia, ADR-6). No incluye lo que existe en código pero
no se usó: Aurora, dominio propio (Route 53/ACM) ni envío real de SMS
(`sms_provider_mode = "capture"`).

Flujo:
CloudFront + WAF -> S3 (app) y API Gateway -> Lambda `api`; outbox con SNS/SQS
hacia los workers; EventBridge dispara el `outbox-poller`; RDS PostgreSQL como
base transaccional única.

Uso (requiere Graphviz: `brew install graphviz`):

    pip install diagrams
    cd docs/architecture && python system_design.py

Genera `orquesta_system_design.png` y `orquesta_system_design.svg` en esta carpeta.
"""

from pathlib import Path

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import RDSPostgresqlInstance
from diagrams.aws.engagement import SimpleEmailServiceSes
from diagrams.aws.general import MobileClient, Users
from diagrams.aws.integration import (
    EventbridgeScheduler,
    SimpleNotificationServiceSnsTopic,
    SimpleQueueServiceSqsQueue,
)
from diagrams.aws.management import Cloudwatch
from diagrams.aws.network import APIGateway, CloudFront
from diagrams.aws.security import KeyManagementService, SecretsManager, WAF
from diagrams.aws.storage import SimpleStorageServiceS3Bucket
from diagrams.saas.payment import Stripe

OUT = Path(__file__).resolve().parent / "orquesta_system_design"

GRAPH = {
    "fontsize": "22",
    "fontname": "Helvetica",
    "labelloc": "t",
    "pad": "0.6",
    "nodesep": "0.55",
    "ranksep": "1.4",
    "splines": "spline",
    "compound": "true",  # permite que una flecha salga del borde de un Cluster
}
NODE = {"fontsize": "12", "fontname": "Helvetica"}
EDGE = {"fontsize": "10", "fontname": "Helvetica"}

LAMBDA_CLUSTER = "Procesamiento asíncrono · Lambda workers"

# Estilos de flecha
sync = dict(color="#232F3E")                       # petición síncrona
async_ = dict(color="#E7157B")                     # mensajería asíncrona
data = dict(color="#3B48CC")                       # lectura / escritura de datos
ext = dict(color="#7AA116")                        # servicio externo
ops = dict(color="#8C8C8C", style="dashed")        # transversal (secretos, logs, firma)


def build(fmt: str) -> None:
    with Diagram(
        "Orquesta · System Design en AWS",
        filename=str(OUT),
        outformat=fmt,
        direction="LR",
        show=False,
        graph_attr=GRAPH,
        node_attr=NODE,
        edge_attr=EDGE,
    ):
        with Cluster("Clientes"):
            planner = Users("Planner · Proveedor\n(navegador)")
            staff = MobileClient("Staff\nPWA offline (IndexedDB)")
            guest = Users("Invitado\nlink por email")
        clients = [planner, staff, guest]

        with Cluster("Entrada / API"):
            waf = WAF("AWS WAF\nrate limit")
            cdn = CloudFront("CloudFront\nCDN · HTTPS")
            api_gw = APIGateway("API Gateway\nHTTP API v2 · throttling")

        with Cluster("Procesamiento síncrono · Lambda"):
            api = Lambda("api\n(monolito modular)")

        with Cluster("Tareas programadas"):
            cron = EventbridgeScheduler("EventBridge\nrate(1 min)")
            poller = Lambda("outbox-poller")

        with Cluster("Mensajería"):
            sns = SimpleNotificationServiceSnsTopic("SNS\norquesta-notifications")
            with Cluster("SQS (cada cola con DLQ)"):
                q_import = SimpleQueueServiceSqsQueue("import_jobs")
                q_proj = SimpleQueueServiceSqsQueue("projection")
                q_sms = SimpleQueueServiceSqsQueue("notify_sms")
                q_email = SimpleQueueServiceSqsQueue("notify_email")

        with Cluster(LAMBDA_CLUSTER):
            importer = Lambda("import-worker")
            projector = Lambda("projector")
            notify_sms = Lambda("notify-sms\n(modo capture: registra,\nno envía SMS)")
            notify_email = Lambda("notify-email")

        with Cluster("Datos"):
            db = RDSPostgresqlInstance("RDS PostgreSQL 16\ndb.t4g.micro\ndatos + outbox + read model")
            s3_assets = SimpleStorageServiceS3Bucket("S3 assets\napp Angular · QR PNG")
            s3_imports = SimpleStorageServiceS3Bucket("S3 imports\nCSV · expira 7 días")

        with Cluster("Seguridad y operación"):
            kms = KeyManagementService("KMS\nfirma ES256 del QR")
            secrets = SecretsManager("Secrets Manager\nBD · sesión · webhook · PII")
            cw = Cloudwatch("CloudWatch\nlogs · EMF · alarmas")

        with Cluster("Externos"):
            stripe = Stripe("Stripe\n(modo test)")
            ses = SimpleEmailServiceSes("Amazon SES\nemail (sandbox)")

        # Entrada
        clients >> Edge(label="HTTPS", **sync) >> waf >> Edge(**sync) >> cdn
        cdn >> Edge(label="GET estático (OAC)", **sync) >> s3_assets
        cdn >> Edge(label="HTTPS /v1/*", **sync) >> api_gw
        api_gw >> Edge(label="Invoca (proxy)", **sync) >> api

        # API síncrona
        api >> Edge(label="Lectura/Escritura\n(dato + evento en la misma TX)", **data) >> db
        api >> Edge(label="Sube CSV", **data) >> s3_imports
        api >> Edge(label="Encola import", **async_) >> q_import
        api >> Edge(label="Publica (flush inmediato)", **async_) >> sns
        api >> Edge(label="Encola proyección", **async_) >> q_proj
        api >> Edge(label="Cobro idempotente", **ext) >> stripe
        stripe >> Edge(label="Webhook HMAC (HTTPS)", constraint="false", **ext) >> api_gw

        # Fan-out y workers
        sns >> Edge(label="Fan-out", **async_) >> [q_sms, q_email]
        q_import >> Edge(label="Trigger", **async_) >> importer
        q_proj >> Edge(label="Trigger", **async_) >> projector
        q_sms >> Edge(label="Trigger", **async_) >> notify_sms
        q_email >> Edge(label="Trigger", **async_) >> notify_email

        importer >> Edge(label="Lee CSV", **data) >> s3_imports
        importer >> Edge(label="Escribe invitados", **data) >> db
        importer >> Edge(label="Escribe QR PNG", **data) >> s3_assets
        projector >> Edge(label="Actualiza contadores", **data) >> db
        notify_email >> Edge(label="Envía email", **ext) >> ses

        # Tareas programadas
        cron >> Edge(label="Trigger", **async_) >> poller
        poller >> Edge(label="Rezagados del outbox,\nrecordatorios, expiraciones", **data) >> db
        poller >> Edge(label="Re-publica", **async_) >> sns
        poller >> Edge(label="Re-encola", **async_) >> q_proj
        poller >> Edge(label="Conciliación", **ext) >> stripe

        # Transversal: salen del borde del cluster de Lambda
        # (todas las Lambdas leen secretos y emiten logs; se dibuja una flecha
        #  desde el borde del cluster de workers para no saturar el diagrama)
        api >> Edge(label="Firma QR", **ops) >> kms
        api >> Edge(label="Lee secretos", **ops) >> secrets
        api >> Edge(label="Logs y métricas", **ops) >> cw
        projector >> Edge(label="Secretos · logs", ltail=f"cluster_{LAMBDA_CLUSTER}", **ops) >> secrets


if __name__ == "__main__":
    for fmt in ("png", "svg"):
        build(fmt)
        print(f"OK -> {OUT}.{fmt}")
