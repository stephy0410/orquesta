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
    "nodesep": "0.7",
    "ranksep": "1.3",
    "splines": "ortho",  # flechas en ángulo recto: menos cruces visuales
    "compound": "true",  # permite que una flecha salga del borde de un Cluster
}
NODE = {"fontsize": "12", "fontname": "Helvetica"}
EDGE = {"fontsize": "11", "fontname": "Helvetica", "penwidth": "1.4"}

SQS_CLUSTER = "SQS (cada cola con DLQ)"
WORKERS_CLUSTER = "Procesamiento asíncrono · Lambda workers"
SEC_CLUSTER = "Seguridad y operación · usado por todas las Lambdas"

# Estilos de flecha
sync = dict(color="#232F3E")                       # petición síncrona
async_ = dict(color="#E7157B")                     # mensajería asíncrona
data = dict(color="#3B48CC")                       # lectura / escritura de datos
ext = dict(color="#7AA116")                        # servicio externo


def e(text: str = "", **style) -> Edge:
    """Edge con la etiqueta como `xlabel` (Graphviz no coloca `label` con splines=ortho)."""
    return Edge(xlabel=text, **style) if text else Edge(**style)


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

        with Cluster("Entrada / API"):
            waf = WAF("AWS WAF\nrate limit")
            cdn = CloudFront("CloudFront\nCDN · HTTPS")
            api_gw = APIGateway("API Gateway\nHTTP API v2")

        with Cluster("Contenido estático"):
            s3_assets = SimpleStorageServiceS3Bucket("S3 assets\napp Angular · QR PNG\n(los QR los escribe import-worker)")

        with Cluster("Procesamiento síncrono"):
            api = Lambda("api\n(monolito modular)")

        with Cluster("Tareas programadas"):
            cron = EventbridgeScheduler("EventBridge\nrate(1 min)")
            poller = Lambda("outbox-poller")

        with Cluster("Mensajería"):
            sns = SimpleNotificationServiceSnsTopic("SNS\norquesta-notifications")
            with Cluster(SQS_CLUSTER):
                q_sms = SimpleQueueServiceSqsQueue("notify_sms")
                q_email = SimpleQueueServiceSqsQueue("notify_email")
                q_proj = SimpleQueueServiceSqsQueue("projection")
                q_import = SimpleQueueServiceSqsQueue("import_jobs")

        with Cluster("Pagos (externo)"):
            stripe = Stripe("Stripe\n(modo test)")

        with Cluster(WORKERS_CLUSTER):
            notify_sms = Lambda("notify-sms\n(modo capture:\nno envía SMS)")
            notify_email = Lambda("notify-email")
            projector = Lambda("projector")
            importer = Lambda("import-worker")

        with Cluster("Datos"):
            db = RDSPostgresqlInstance("RDS PostgreSQL 16\ndb.t4g.micro\ndatos + outbox + read model")
            s3_imports = SimpleStorageServiceS3Bucket("S3 imports\nCSV · expira 7 días")

        with Cluster("Correo"):
            ses = SimpleEmailServiceSes("Amazon SES\n(sandbox)")

        with Cluster(SEC_CLUSTER):
            kms = KeyManagementService("KMS\nfirma ES256 del QR")
            secrets = SecretsManager("Secrets Manager")
            cw = Cloudwatch("CloudWatch\nlogs · métricas · alarmas")

        # 1. Entrada
        [planner, staff, guest] >> e("HTTPS", **sync) >> waf
        waf >> e(**sync) >> cdn
        cdn >> e("estático", **sync) >> s3_assets
        cdn >> e("/v1/*", **sync) >> api_gw
        api_gw >> e("invoca", **sync) >> api

        # 2. API síncrona: escribe dato + evento (outbox) y hace flush inmediato
        api >> e("lee / escribe\n(dato + evento, misma TX)", **data) >> db
        api >> e("publica / encola\n(flush inmediato)", lhead="cluster_Mensajería", **async_) >> q_proj
        api >> e("sube CSV", **data) >> s3_imports
        api >> e("cobro · webhook HMAC", dir="both", **ext) >> stripe

        # 3. Fan-out y workers
        sns >> e("fan-out", **async_) >> [q_sms, q_email]
        q_sms >> e("trigger", **async_) >> notify_sms
        q_email >> e("trigger", **async_) >> notify_email
        q_proj >> e("trigger", **async_) >> projector
        q_import >> e("trigger", **async_) >> importer

        notify_email >> e("envía", **ext) >> ses
        projector >> e("contadores", **data) >> db
        importer >> e("invitados", **data) >> db
        importer >> e("lee CSV", **data) >> s3_imports

        # 4. Tareas programadas
        cron >> e("trigger", **async_) >> poller
        poller >> e("re-publica rezagados", lhead="cluster_Mensajería", **async_) >> sns
        poller >> e("recordatorios ·\nexpiraciones", **data) >> db
        poller >> e("conciliación", **ext) >> stripe

        # 5. Transversal: todas las Lambdas firman (KMS), leen secretos y mandan logs.
        #    Se indica en el título del grupo; aquí solo se posiciona con aristas invisibles.
        api >> Edge(style="invis") >> kms >> Edge(style="invis") >> secrets >> Edge(style="invis") >> cw


if __name__ == "__main__":
    for fmt in ("png", "svg"):
        build(fmt)
        print(f"OK -> {OUT}.{fmt}")
