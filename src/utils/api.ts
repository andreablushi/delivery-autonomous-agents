import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import { exit } from "node:process";
import { createLogger } from "./logger.js";

const log = createLogger("api");

/**
 * Connects to the Deliveroo server using the DjsConnect function from the SDK.
 * It holds checks for connection success and errors, logging the appropriate messages.
 * @param token - An optional token to authenticate the connection
 */
export async function connect(token?: string): Promise<any> {
    const socket: any = DjsConnect(process.env.HOST, token ?? process.env.TOKEN);
    // Log a message when the connection is successfully established
    socket.on('connect', () => {
        console.log("Connected to server!");
    });
    // Log any connection errors and exit the process with an error code
    socket.on("connect_error", (error) => {
        log.error("Connection error:", error);
        exit(1);
    });
    return socket;
}
