# **Technical Requirements Document: AgentGuard**

## **1\. System Overview & Architectural Thesis**

This document outlines the technical architecture for the AgentGuard middleware, defining how the system will be built \[cite: 2\]. The core architectural thesis is to build a deterministic, observable middleware layer around the provided Agent runtime \[cite: 2\]. Within this system, telemetry acts as the feedback loop, failures are treated as incidents, recovery relies on policy-driven actions, and checkpoints serve as the mechanism to allow an Agent to resume safely \[cite: 2\].

## **2\. Integration Points & Infrastructure**

> * The existing starter kit provides a Fastify API, AgentService, AgentRunner interface, JSON persistence, and local containers such as Docker, Colima, or Podman \[cite: 1\].  
> * AgentGuard middleware will integrate at the Fastify request boundary, the Agent Service, and the AgentRunner interface \[cite: 1\].  
> * The backend implementation will focus on modifying the AgentService, AgentRunner, Run lifecycle, Execution events, Persistence, and Recovery state \[cite: 3\].

## **3\. Core Implementation Components**

> * **Event/Trace Collector:** Captures execution events from the runtime \[cite: 3\].  
> * **Trace Store:** Persists the collected event data \[cite: 3\].  
> * **Failure Detector / Monitor:** Analyzes the trace data to identify failures like timeouts or crashes \[cite: 3\].  
> * **Recovery Controller:** Manages the execution of retry, restart, resume, or abort strategies \[cite: 3\].  
> * **Checkpoint / Resume Mechanism:** Handles the state capture and restoration of the Agent's workspace \[cite: 3\].  
> * **Minimal Dashboard:** A lightweight frontend to visualize runs, trace timelines, failures, incidents, recovery status, and recovery history \[cite: 3\].

## **4\. Data Entities**

The middleware will manage the following core data entities:

> * **Run:** Tracks the overall Agent execution and its recovery attempts \[cite: 3\].  
> * **TraceEvent:** Represents individual spans, errors, and status updates \[cite: 3\].  
> * **Incident:** Represents a detected failure associated with a specific run and event \[cite: 3\].  
> * **RecoveryAttempt:** Tracks the specific strategy and status of a recovery action applied to an incident \[cite: 3\].  
> * **Checkpoint:** Stores the workspace state, session ID, and run ID to enable resuming \[cite: 2, 3\].

## **5\. Proposed APIs**

The MVP will include a minimal set of API endpoints for observability and testing:

| Method & Endpoint | Purpose   |
| :---- | :---- |
| POST /runs \[cite: 2\] | Create a new Agent run \[cite: 2\]. |
| GET /runs/:runId \[cite: 2\] | Retrieve the status of a specific run \[cite: 2\]. |
| GET /runs/:runId/events \[cite: 2\] | Retrieve the trace events for a run \[cite: 2\]. |
| GET /incidents \[cite: 2\] | List all detected failure incidents \[cite: 2\]. |
| GET /runs/:runId/recoveries \[cite: 2\] | Retrieve recovery attempts for a specific run \[cite: 2\]. |
| POST /runs/:runId/fail \[cite: 2\] | Inject a controlled failure for demo and testing purposes \[cite: 2\]. |

## **6\. Architectural Decision Records (ADRs)**

> * **ADR-001 (Deterministic Recovery Policies):** Use predefined recovery strategies rather than letting an LLM invent recovery actions \[cite: 2\].  
> * **ADR-002 (Middleware Owns Recovery):** Recovery should be implemented outside the Agent itself \[cite: 2\].  
> * **ADR-003 (Event-Based Observability):** Represent Agent execution as structured events \[cite: 2\].  
> * **ADR-004 (Checkpointing):** Maintain checkpoints at meaningful execution boundaries so recoverable failures can resume rather than restart from scratch \[cite: 2\].

## **7\. Testing Strategy**

> * **Unit Tests:** Validate failure classification, policy selection, retry limits, state transitions, checkpoint creation, and checkpoint restoration \[cite: 2\].  
> * **Integration Tests:** Verify the data flow through the Agent, Middleware, Failure, Recovery, and Runtime components \[cite: 2\].  
> * **End-to-End (E2E) Tests:** Must cover a normal successful run, a runtime crash leading to a restart/resume, a recovery exhaustion leading to an abort, and a timeout leading to a successful retry \[cite: 2\].