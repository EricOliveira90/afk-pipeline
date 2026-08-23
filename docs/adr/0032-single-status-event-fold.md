# Fold status records once into RunSnapshot

The `afk status` read side folds a run's event history and run state exactly once into a `RunSnapshot`. Past, Present, Future, and dashboard views derive from that snapshot instead of maintaining partial event state machines, so phase pairing, terminal outcomes, lane and wave facts, and event/state reconciliation have one owner; manifest and agent-log reads remain separate inputs because they are not part of the run event stream.
