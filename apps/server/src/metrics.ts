import { Counter, collectDefaultMetrics, Histogram, Registry } from "@prometheus-io/client";

export interface HttpMetricObservation {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
}

export interface ApiMetrics {
  readonly contentType: string;
  observeHttp(input: HttpMetricObservation): void;
  render(): Promise<string>;
}

/** Creates an isolated registry so tests and multiple in-process app instances never collide. */
export function createApiMetrics(): ApiMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "agentworld-api" });
  collectDefaultMetrics({ register: registry, prefix: "agentworld_" });

  const requests = new Counter({
    name: "agentworld_http_requests_total",
    help: "Completed AgentWorld HTTP requests",
    labelNames: ["method", "route", "status_class"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "agentworld_http_request_duration_seconds",
    help: "AgentWorld HTTP request duration in seconds",
    labelNames: ["method", "route", "status_class"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  return {
    contentType: registry.contentType,
    observeHttp(input) {
      const labels = {
        method: input.method,
        route: input.route,
        status_class: `${Math.floor(input.statusCode / 100)}xx`,
      };
      requests.inc(labels);
      duration.observe(labels, input.durationSeconds);
    },
    render: () => registry.metrics(),
  };
}
