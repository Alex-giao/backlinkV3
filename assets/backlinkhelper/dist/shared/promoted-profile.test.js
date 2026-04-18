import test from "node:test";
import assert from "node:assert/strict";
import { applyDossierUpdates } from "./promoted-profile.js";
function makeProfile(overrides = {}) {
    return {
        url: "https://exactstatement.com/",
        hostname: "exactstatement.com",
        name: "Exact Statement",
        description: "Convert bank statement PDFs to CSV and Excel.",
        category_hints: ["finance"],
        source: "deep_probe",
        dossier_fields: {},
        ...overrides,
    };
}
test("applyDossierUpdates upserts canonical dossier fields as user_confirmed values", () => {
    const updated = applyDossierUpdates({
        profile: makeProfile(),
        updates: [
            { key: "phone_number", value: "+1-307-555-0100" },
            { key: "city", value: "Sheridan" },
        ],
        sourceType: "user_confirmed",
    });
    assert.equal(updated.dossier_fields?.phone_number?.value, "+1-307-555-0100");
    assert.equal(updated.dossier_fields?.phone_number?.source_type, "user_confirmed");
    assert.equal(updated.dossier_fields?.city?.value, "Sheridan");
    assert.equal(updated.dossier_fields?.city?.allowed_for_autofill, true);
});
test("applyDossierUpdates preserves existing dossier fields while overwriting updated keys", () => {
    const updated = applyDossierUpdates({
        profile: makeProfile({
            dossier_fields: {
                phone_number: {
                    key: "phone_number",
                    label: "Phone Number",
                    value: "+1-307-555-0000",
                    source_type: "operator_default",
                    confidence: "medium",
                    updated_at: "2026-04-12T00:00:00.000Z",
                    reuse_scope: "promoted_site",
                    allowed_for_autofill: true,
                },
            },
        }),
        updates: [{ key: "phone_number", value: "+1-307-555-0100" }],
        sourceType: "user_confirmed",
    });
    assert.equal(updated.dossier_fields?.phone_number?.value, "+1-307-555-0100");
    assert.equal(updated.dossier_fields?.phone_number?.source_type, "user_confirmed");
});
