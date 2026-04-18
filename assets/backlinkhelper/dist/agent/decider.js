import { createOpenAIDecider } from "./openai-decider.js";
function requireEnvValue(key) {
    const value = process.env[key]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable ${key} for the agent backend.`);
    }
    return value;
}
export function resolveAgentBackendConfig() {
    const backend = (process.env.BACKLINER_AGENT_BACKEND ?? "openai").trim().toLowerCase();
    if (backend !== "openai") {
        throw new Error(`Unsupported BACKLINER_AGENT_BACKEND "${backend}". Only "openai" is currently implemented.`);
    }
    return {
        backend: "openai",
        model: (process.env.BACKLINER_AGENT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.3-codex").trim(),
        base_url: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
        api_key_env: process.env.BACKLINER_AGENT_API_KEY_ENV?.trim() || "OPENAI_API_KEY",
    };
}
export function validateAgentBackendConfig() {
    try {
        const config = resolveAgentBackendConfig();
        requireEnvValue(config.api_key_env);
        return {
            ok: true,
            detail: `Agent backend "${config.backend}" is configured with model "${config.model}" and API key env "${config.api_key_env}".`,
            config,
        };
    }
    catch (error) {
        return {
            ok: false,
            detail: error instanceof Error ? error.message : "Agent backend validation failed.",
        };
    }
}
export function createAgentDecider() {
    const config = resolveAgentBackendConfig();
    requireEnvValue(config.api_key_env);
    return createOpenAIDecider(config);
}
