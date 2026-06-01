---
description: Worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use id "worker" with session "new" to implement: $@
2. Then, use id "reviewer" with session "new" to review the implementation from the previous step (use {previous} placeholder)
3. Finally, use id "worker" with session "new" to apply the feedback from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Every chain step must include session: "new".
