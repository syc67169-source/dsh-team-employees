# Plugin stability implementation plan

Goal: Prevent concurrent data loss and make the pipeline state, model settings and cost reporting truthful.
Architecture: Keep JSON storage with reentrant cross-process locks and revision checks. Derive dashboard views from a shared snapshot. Keep local package preparation distinct from human publication confirmation.
Tech stack: Node built-ins, existing Cordis host APIs, React client.

1. Add storage locks/unique atomic temp files; wrap item mutations, roster edits, metrics and weights. Test concurrent workers, duplicate creation and stale writes.
2. Deduplicate index before filtering; compact the summary index. Share dashboard reads and remove the 200-item truncation. Test queue and totals.
3. Keep package preparation queued; require human confirmation and publication reference before published; reject premature metrics. Add authenticated, origin-checked human action UI. Test lifecycle and routes.
4. Resolve saved employee model at agent initialization using the installed runtime's lifecycle contract, or explicitly surface unsupported settings. Verify installed model-selection ownership and label the unsupported field as notes.
5. Remove automatic global-delta cost attribution. Report unallocated costs accurately and prevent telemetry errors from failing committed business actions.
6. Add request timeout, cancellation and non-overlapping polling; consolidate output schemas; document limitations and run all tests.
7. Restart the desktop app and verify office and composer rendering without modifying real content or submitting publication actions.

Completed: storage/CAS, queue/index, stage/metrics validation, human UI, unsupported-model labeling, cost correction, shared reads/log tail, fetch lifecycle and regressions. Media renderer and employee-specific model routing are explicitly outside this repair. Locks fail safely after crashed writers and require manual cleanup with all writers stopped.
