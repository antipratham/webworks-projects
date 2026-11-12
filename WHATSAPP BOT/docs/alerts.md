# Alerting

Metrics are served at `GET /metrics` in Prometheus text format. That format was
chosen because Prometheus, Grafana Agent, the Datadog OpenMetrics check, New
Relic and the CloudWatch agent all scrape it — so the monitoring stack can be
decided later without touching this service.

**`/metrics` is unauthenticated, like every `/metrics` endpoint.** Bind it to the
internal network or keep it behind the ingress. It carries no guest data: labels
are event types, error codes and outlet names only, never a phone number, a name
or a message id.

## The five alerts that matter

Ordered by how bad it is when nobody notices. Copy into
`prometheus/rules/whatsapp.yml`.

```yaml
groups:
  - name: whatsapp-service
    rules:

      # 1. Nothing is being delivered.
      #    A restaurant's guests stop getting confirmations. This is the one
      #    that must page a human at 9pm on a Friday.
      - alert: WhatsAppSendsFailing
        expr: |
          sum by (outlet) (rate(restoos_wa_messages_failed_total[10m]))
          /
          clamp_min(sum by (outlet) (rate(restoos_wa_messages_sent_total[10m]))
                  + sum by (outlet) (rate(restoos_wa_messages_failed_total[10m])), 0.001)
          > 0.2
        for: 10m
        labels: { severity: page }
        annotations:
          summary: "Over 20% of sends failing at {{ $labels.outlet }}"
          runbook: "Check restoos_wa_messages_failed_total by meta_code. 132001 means a template is unapproved or paused; 190 or 0 means the token is dead."

      # 2. The queue is backing up or the worker has stopped.
      - alert: WhatsAppQueueStalled
        expr: restoos_wa_messages_stuck{state="QUEUED"} > 20
        for: 10m
        labels: { severity: page }
        annotations:
          summary: "{{ $value }} messages queued over five minutes"
          runbook: "Check the dispatch worker is running and Redis is reachable. The reconciler requeues orphans within a minute, so a number that keeps climbing means the worker, not the enqueue."

      # 3. A restaurant cannot send at all.
      #    Silent otherwise: their messages simply fail one by one.
      - alert: WhatsAppCredentialsUnhealthy
        expr: restoos_wa_credentials_unhealthy > 0
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "{{ $value }} outlet(s) with {{ $labels.status }} WhatsApp credentials"
          runbook: "TOKEN_EXPIRED needs the restaurant to re-run Embedded Signup, or a system-user token refresh. Nothing sends for that outlet until it is fixed."

      # 4. Delivery receipts have stopped arriving.
      #    Sends still work, so nothing looks wrong — but every message sits in
      #    SENT forever and the owner dashboard quietly starts lying.
      - alert: WhatsAppWebhooksSilent
        expr: |
          rate(restoos_wa_webhooks_received_total{outcome="accepted"}[30m]) == 0
          and rate(restoos_wa_messages_sent_total[30m]) > 0
        for: 30m
        labels: { severity: ticket }
        annotations:
          summary: "Sending, but no webhooks for 30 minutes"
          runbook: "Check the callback URL in the Meta app config and that the ingress reaches /webhook. A spike in outcome=bad_signature means META_APP_SECRET is wrong."

      # 5. Time-critical messages are arriving late.
      #    The call-fallback promise is 30 seconds; a table-ready ping is worth
      #    nothing five minutes after the table was given away.
      - alert: WhatsAppUrgentMessagesSlow
        expr: |
          histogram_quantile(0.95,
            sum by (le) (rate(restoos_wa_queue_latency_seconds_bucket{urgent="true"}[15m]))
          ) > 30
        for: 15m
        labels: { severity: ticket }
        annotations:
          summary: "p95 latency for urgent messages is over 30s"
          runbook: "Usually a campaign saturating the per-number rate limit. Check restoos_wa_queue_depth and whether a send is throttled."
```

## Worth a dashboard, not an alert

- `restoos_wa_messages_blocked_total` by `reason` — a jump in `CONSENT` means a
  campaign targeted a segment it should not have; a jump in `MIN_GAP` means
  something is scheduling reminders too close to confirmations.
- `restoos_wa_feedback_rating` — the p50 by outlet is the closest thing to a live
  satisfaction score, and a sudden drop usually beats the reviews by a day.
- `restoos_wa_orphans_requeued_total` — should be zero. Anything above zero means
  the process is dying between the Postgres commit and the Redis enqueue, and the
  reconciler is covering for it.
- `restoos_wa_retention_redacted_total{trigger="erasure"}` — erasure volume, for
  the privacy report nobody asks for until they do.

## Health endpoints

| Path | Use |
|---|---|
| `/healthz` | Liveness. Process is up. Never touches the database. |
| `/readyz` | Readiness. Fails when Postgres is unreachable, so the load balancer drops the instance instead of accepting writes it cannot persist. |
| `/metrics` | Scrape target. 404s when `METRICS_ENABLED=false`. |
