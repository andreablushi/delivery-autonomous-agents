import { connect } from "./utils/api.js";
import { BDIAgent } from "./agents/bdi/bdi_agent.js";
import { LLMAgent } from "./agents/llm/llm_agent.js";
import { exit } from "node:process";

/**
 * Entry point of the application.
 */
async function main() {
    const isCompetitive = process.env.COMPETITIVE === "true";

    // Always start a single agent
    await startSingleAgent();

    // If we selected competitive mode, also start the competitive agents.
    if (isCompetitive) {
        await startCompetitiveAgents();
        return;
    }
}

/**
 * Starts a single agent using TOKEN.
 */
async function startSingleAgent(): Promise<void> {
    const socket = await connect(process.env.TOKEN);
    spawnAgent(socket);
}

/**
 * Starts multiple agents using TOKEN_1, TOKEN_2, ...
 * Each agent receives an `agent-N` id so interleaved logs are demuxable.
 */
async function startCompetitiveAgents(): Promise<void> {
    // Collect all TOKEN_N from the environment variables
    const tokens: string[] = [];
    for (let i = 1; ; i++) {
        const token = process.env[`TOKEN_${i}`];
        if (!token) {
            break;
        }
        tokens.push(token);
    }

    // If no tokens are found, log an error and exit
    if (tokens.length === 0) {
        console.error("No TOKEN_1 found. Add TOKEN_1, TOKEN_2, ... to .env");
        exit(1);
    }

    // Launch an agent for each token and wait for all connections to be established before starting the agents
    console.log(`Launching ${tokens.length} competitive agent(s)...`);
    const sockets = await Promise.all(tokens.map((token) => connect(token)));
    sockets.forEach((socket, i) => spawnAgent(socket, `agent-${i + 1}`));
}

function spawnAgent(socket: any, agentId?: string): void {
    if (process.env.AGENT_KIND === "llm") new LLMAgent(socket, agentId);
    else new BDIAgent(socket, agentId);
}


// Run the main function and catch any errors for logging
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
