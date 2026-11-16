# Member command blocked control traffic

## Executive summary

A held command callback prevented a following receipt query from returning on a live member WebSocket. The same frame queue also processed heartbeat acknowledgments. Bounded callback execution now leaves frame handling and reconciliation available while retaining shutdown ownership.

## Summary

The member bridge awaited each command inside its serial frame handler. This worked for short input transactions, but native controls can wait for execution to settle. A real WSS regression held a control and sent a query; the query exceeded its observation deadline. The queued heartbeat acknowledgments could not renew the connection's negotiated lease during that wait.

## Timeline

- Native cancellation integration exposed the need to query reception while physical work drains.
- A real WSS test held a control and failed to receive an independent query response.
- Command callbacks were separated from ordered frame validation with bounded execution and reconciliation windows.
- The regression received its query and continued heartbeats beyond the negotiated offline interval.
- Additional tests covered capacity refusal, released-slot reuse, duplicate identities and disposal before callback completion.

## Root cause

Transport ordering was used to serialize business-operation completion. A long operation thereby blocked the control traffic needed to keep its connection alive and observe its durable receipt. Closing on callback saturation would also misclassify legitimate long-running work as protocol failure.

## Guardrails

The member connection suite verifies independent heartbeat/query progress, both count and byte limits, reconciliation under saturation, slot reuse and full callback drainage. Service forwarding tests retain the original request identity and unsent classification on an explicit capacity refusal, then exercise query/skip retry. Runtime ownership guidance requires bounded control traffic independent of business completion.

## Lessons

Frame validation and durable command ordering do not require serial completion of all native work. Keep reconciliation available, bound every retained payload and drain admitted callbacks before disposing their Runtime.
