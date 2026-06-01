---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use id "scout" to find all code relevant to: $@
2. Then, use id "planner" to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use id "worker" to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
