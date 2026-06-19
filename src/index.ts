import { connect } from "./utils/api.js";
import { BDIAgent } from "./agents/bdi/bdi_agent.js";
import { LLMAgent } from "./agents/llm/llm_agent.js";
import { exit } from "node:process";

async function main() {
    // Determine the mode of operation based on the environment variable MODE
    const mode = process.env.MODE ?? "bdi";
    switch (mode) {
        case "bdi": {
            const socket = await connect(process.env.BDI_TOKEN);
            new BDIAgent(socket);
            break;
        }
        
        case "llm": {
            const socket = await connect(process.env.LLM_TOKEN);
            new LLMAgent(socket);
            break;
        }
        
        case "cooperative": {
            const [llmSocket, bdiSocket] = await Promise.all([
                connect(process.env.LLM_TOKEN),
                connect(process.env.BDI_TOKEN),
            ]);
            // Initialize the LLM agent with the BDI agent's ID as a teammate, and vice versa
            const bdiId = process.env.BDI_ID;
            const llmId = process.env.LLM_ID;
            new LLMAgent(llmSocket, "llm", bdiId ? [bdiId] : []);
            new BDIAgent(bdiSocket, "bdi", llmId ? [llmId] : []);
            break;
        }
        
        // Competitive mode: Launch multiple BDI agents, each one going against the others.
        // The number of agents is determined by the number of COMPETITIVE_TOKEN_1, COMPETITIVE_TOKEN_2, ... environment variables.
        case "competitive": {
            // Retrieve all competitive tokens from the environment variables
            const tokens: string[] = [];
            for (let i = 1; ; i++) {
                const token = process.env[`COMPETITIVE_TOKEN_${i}`];
                if (!token) break;
                tokens.push(token);
            }

            if (tokens.length === 0) {
                console.error("No COMPETITIVE_TOKEN_1 found. Add COMPETITIVE_TOKEN_1, COMPETITIVE_TOKEN_2, ... to .env");
                exit(1);
            }

            console.log(`Launching ${tokens.length} competitive BDI agent(s)...`);
            const sockets = await Promise.all(tokens.map(t => connect(t)));
            sockets.forEach((socket, i) => new BDIAgent(socket, `agent-${i + 1}`));
            break;
        }
        
        default: {
            console.error(`Unknown MODE="${mode}". Expected: bdi | llm | cooperative | competitive`);
            exit(1);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});