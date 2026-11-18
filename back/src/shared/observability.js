// Emisor CloudWatch Embedded Metric Format (EMF) para NFR-09

export class MetricsEmitter {
  constructor({ namespace = "Orquesta", sink = null, silent = false } = {}) {
    this.namespace = namespace;
    this.sink = sink;
    this.silent = silent;
    this.records = [];
  }

  emit(metricName, value, unit = "Count", dimensions = {}, extra = {}) {
    const dimKeys = Object.keys(dimensions);
    const payload = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: this.namespace,
            Dimensions: dimKeys.length > 0 ? [dimKeys] : [[]],
            Metrics: [{ Name: metricName, Unit: unit }],
          },
        ],
      },
      ...dimensions,
      [metricName]: value,
      ...extra,
    };

    this.records.push({ metricName, value, unit, dimensions, extra, payload });
    if (typeof this.sink === "function") {
      this.sink(payload);
    } else if (!this.silent && process.env.NODE_ENV !== "test" && process.env.ORQUESTA_SILENT_EMF !== "1") {
      console.log(JSON.stringify(payload));
    }
    return payload;
  }

  checkinRate(eventId, count) {
    return this.emit("checkin_rate", count, "Count", { EventId: eventId });
  }

  lagFrescura(eventId, lagMs) {
    return this.emit("lag_frescura", lagMs, "Milliseconds", { EventId: eventId });
  }

  reservationConflicts(workerId) {
    return this.emit("reservation_conflicts", 1, "Count", { WorkerId: workerId });
  }

  notifRetry(canal) {
    return this.emit("notif_retry", 1, "Count", { Canal: canal });
  }

  notifBounce(canal) {
    return this.emit("notif_bounce", 1, "Count", { Canal: canal });
  }

  pspError(reason = "unknown") {
    return this.emit("psp_error", 1, "Count", { Reason: reason });
  }

  offlineQueueDepth(eventId, deviceId, depth) {
    return this.emit(
      "offline_queue_depth",
      depth,
      "Count",
      { EventId: eventId, DeviceId: deviceId },
      { alert_gt_500: depth > 500 }
    );
  }

  workerSearchZeroResults() {
    return this.emit("worker_search_zero_results", 1, "Count", {});
  }

  providerNoShow(eventId, count = 1) {
    return this.emit("provider_no_show", count, "Count", { EventId: eventId });
  }
}
