/**
 * agentPipeline.js
 * Lightweight multi-agent framework.
 *
 * Each Agent has a single responsibility and a process() method.
 * A Pipeline chains agents — output of one becomes input of next.
 * The Orchestrator creates specialized pipelines per email type.
 *
 * Architecture:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │              OrchestratorAgent               │
 *   │   routes emails → TimesheetPipeline          │
 *   │                  → SubmissionPipeline         │
 *   └─────────────────────────────────────────────┘
 *          │                        │
 *   ┌──────▼──────┐          ┌──────▼──────┐
 *   │  Timesheet  │          │ Submission  │
 *   │  Pipeline   │          │  Pipeline   │
 *   │  Parser     │          │  Parser     │
 *   │  Anomaly    │          │  QAAgent    │
 *   │  Payment    │          │  Payment    │
 *   │  EmailWriter│          │  EmailWriter│
 *   └─────────────┘          └─────────────┘
 */

export class Agent {
  /**
   * @param {string} name        — display name shown in logs
   * @param {Function} handler   — async (context) => updatedContext
   */
  constructor(name, handler) {
    this.name = name;
    this.handler = handler;
  }

  async process(context) {
    const start = Date.now();
    console.log(`  [${this.name}] ▶ starting`);
    try {
      const result = await this.handler(context);
      console.log(`  [${this.name}] ✓ done in ${Date.now() - start}ms`);
      return result ?? context;
    } catch (err) {
      console.error(`  [${this.name}] ✗ error: ${err.message}`);
      throw err;
    }
  }
}

export class Pipeline {
  /**
   * @param {string}  name    — pipeline identifier
   * @param {Agent[]} agents  — ordered list of agents to run
   */
  constructor(name, agents) {
    this.name = name;
    this.agents = agents;
  }

  /**
   * Run all agents in sequence, passing context through.
   * Any agent can set context.halt = true to stop the pipeline early
   * (e.g. after sending a clarification email — no payment needed).
   *
   * @param {object} initialContext
   * @returns {Promise<object>} final context
   */
  async run(initialContext) {
    console.log(`\n[Pipeline:${this.name}] ── Starting (${this.agents.length} agents)`);
    let ctx = { ...initialContext };

    for (const agent of this.agents) {
      if (ctx.halt) {
        console.log(`[Pipeline:${this.name}] ⏹ Halted after ${agent.name} step`);
        break;
      }
      ctx = await agent.process(ctx);
    }

    console.log(`[Pipeline:${this.name}] ── Complete. Status: ${ctx.status ?? "unknown"}`);
    return ctx;
  }
}

/**
 * Router — picks the right pipeline based on email type.
 * New pipelines can be registered at runtime.
 */
export class AgentRouter {
  constructor() {
    this.routes = new Map(); // emailType → Pipeline
  }

  register(emailType, pipeline) {
    this.routes.set(emailType, pipeline);
    return this;
  }

  async route(context) {
    const pipeline = this.routes.get(context.emailType);
    if (!pipeline) {
      console.warn(`[AgentRouter] No pipeline for emailType="${context.emailType}" — skipping`);
      return { ...context, status: "unrouted" };
    }
    return pipeline.run(context);
  }
}
