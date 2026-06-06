---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subprocess tool with the chain parameter to execute this workflow:

1. First, use id "scout" with session "new" to find all code relevant to: $@
2. Then, use id "planner" with session "new" to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Every chain step must include session: "new". Do NOT implement - just return the plan.
