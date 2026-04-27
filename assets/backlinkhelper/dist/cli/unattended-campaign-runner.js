import { runUnattendedCampaign } from "../control-plane/unattended-campaign-runner.js";
export async function runUnattendedCampaignCommand(args) {
    const result = await runUnattendedCampaign(args);
    console.log(JSON.stringify(result, null, 2));
}
