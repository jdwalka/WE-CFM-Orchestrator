"""
GitLab Observability (o11y) OpenTelemetry Exporter for WE-CRYPTO
Endpoint: https://106106905.otel.gitlab-o11y.com:14318/v1/traces
GitLab Group ID: 106106905 (WalkersHooligans)
Project ID: 86072669 (wecrypto)
"""

import os
import sys

def init_tracer(service_name: str = None):
    """
    Initializes OpenTelemetry TracerProvider configured for GitLab Observability.
    Falls back gracefully if opentelemetry packages are not installed.
    """
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource

        svc = service_name or os.environ.get("CI_PROJECT_NAME", "wecrypto-orchestrator")
        resource = Resource.create({
            "service.name": svc,
            "service.version": os.environ.get("CI_COMMIT_SHA", "v2.15.6"),
            "deployment.environment.name": os.environ.get("CI_ENVIRONMENT_NAME", "production"),
            "gitlab.project.id": os.environ.get("CI_PROJECT_ID", "86072669"),
            "gitlab.project.name": os.environ.get("CI_PROJECT_NAME", "wecrypto"),
        })

        headers = {}
        token = (
            os.environ.get("GITLAB_O11Y_TOKEN")
            or os.environ.get("GITLAB_TOKEN")
            or os.environ.get("PRIVATE_TOKEN")
        )
        if token:
            headers["Authorization"] = f"Bearer {token}"

        endpoint = os.environ.get(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "https://106106905.otel.gitlab-o11y.com:14318/v1/traces"
        )

        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(
            endpoint=endpoint,
            headers=headers if headers else None
        )
        processor = BatchSpanProcessor(exporter)
        provider.add_span_processor(processor)
        trace.set_tracer_provider(provider)
        return trace.get_tracer(svc)
    except ImportError:
        return None

if __name__ == "__main__":
    tracer = init_tracer("wecrypto-cli-smoke")
    if tracer:
        with tracer.start_as_current_span("test-span") as span:
            span.set_attribute("test.status", "ok")
            span.set_attribute("telemetry.target", "gitlab-o11y")
        print("[OK] GitLab Observability span emitted successfully.")
    else:
        print("opentelemetry not installed. Run: pip install opentelemetry-sdk opentelemetry-exporter-otlp")
