import { connect } from "./utils/api.js";
import { BDIAgent } from "./agents/bdi/bdi_agent.js";
import { LLMAgent } from "./agents/llm/llm_agent.js";
import { exit } from "node:process";

async function main() {
    const mode = process.env.MODE ?? "bdi";

    if (mode === "bdi") {
        const socket = await connect(process.env.BDI_TOKEN);
        new BDIAgent(socket);

    } else if (mode === "llm") {
        const socket = await connect(process.env.LLM_TOKEN);
        new LLMAgent(socket);

    } else if (mode === "cooperative") {
        const [llmSocket, bdiSocket] = await Promise.all([
            connect(process.env.LLM_TOKEN),
            connect(process.env.BDI_TOKEN),
        ]);
        new LLMAgent(llmSocket, "llm");
        new BDIAgent(bdiSocket, "bdi");

    } else if (mode === "competitive") {
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

    } else {
        console.error(`Unknown MODE="${mode}". Expected: bdi | llm | cooperative | competitive`);
        exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
