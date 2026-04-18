import test from "node:test";
import assert from "node:assert/strict";

import { extractMissingInputFields, summarizeMissingInputPreflight } from "./missing-inputs.js";
import type { PromotedProfile, TaskRecord } from "./types.js";

function makeProfile(overrides: Partial<PromotedProfile> = {}): PromotedProfile {
  return {
    url: "https://exactstatement.com/",
    hostname: "exactstatement.com",
    name: "Exact Statement",
    description: "Convert bank statement PDFs to CSV and Excel.",
    category_hints: ["finance"],
    company_name: "Exact Statement",
    contact_email: "support@exactstatement.com",
    source: "deep_probe",
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    target_url: "https://directory.example.com/submit",
    hostname: "directory.example.com",
    submission: {
      promoted_profile: makeProfile(),
      confirm_submit: true,
    },
    status: "WAITING_MISSING_INPUT",
    created_at: "2026-04-11T00:00:00.000Z",
    updated_at: "2026-04-11T00:00:00.000Z",
    run_count: 1,
    escalation_level: "takeover",
    takeover_attempts: 1,
    wait: {
      wait_reason_code: "REQUIRED_INPUT_MISSING",
      resume_trigger: "Terminal audit only. Missing required fields: Country, State / Province, Founded Date.",
      resolution_owner: "none",
      resolution_mode: "terminal_audit",
      evidence_ref: "artifact.json",
    },
    phase_history: [],
    latest_artifacts: ["artifact.json"],
    notes: [],
    ...overrides,
  };
}

test("extractMissingInputFields returns richer metadata for normalized common fields from free text", () => {
  const fields = extractMissingInputFields([
    "Current missing required fields: Country, State / Province, Founded Date.",
  ]);

  assert.deepEqual(
    fields.map((field) => ({
      key: field.key,
      label: field.label,
      field_class: field.field_class,
      confidence: field.confidence,
      source_hint: field.source_hint,
      recommended_resolution: field.recommended_resolution,
    })),
    [
      {
        key: "country",
        label: "Country",
        field_class: "public_factual",
        confidence: "medium",
        source_hint: "parsed_from_text",
        recommended_resolution: "backfill_from_dossier",
      },
      {
        key: "state_province",
        label: "State / Province",
        field_class: "public_factual",
        confidence: "medium",
        source_hint: "parsed_from_text",
        recommended_resolution: "backfill_from_dossier",
      },
      {
        key: "founded_date",
        label: "Founded Date",
        field_class: "public_factual",
        confidence: "medium",
        source_hint: "parsed_from_text",
        recommended_resolution: "backfill_from_dossier",
      },
    ],
  );
});

test("extractMissingInputFields normalizes common field aliases from free text", () => {
  const fields = extractMissingInputFields([
    "This form requires Phone Number, Address Line 1, Town / City, and Postcode before it can be submitted.",
  ]);

  assert.deepEqual(
    fields.map((field) => field.key),
    ["postal_code", "address_line_1", "city", "phone_number"],
  );
  assert.deepEqual(
    fields.map((field) => ({ key: field.key, label: field.label, field_class: field.field_class })),
    [
      { key: "postal_code", label: "Postal Code", field_class: "operator_default" },
      { key: "address_line_1", label: "Address Line 1", field_class: "operator_default" },
      { key: "city", label: "City", field_class: "operator_default" },
      { key: "phone_number", label: "Phone Number", field_class: "operator_default" },
    ],
  );
});

test("summarizeMissingInputPreflight separates dossier-backed resolved fields, auto-resolvable profile fields, and unresolved fields", () => {
  const report = summarizeMissingInputPreflight({
    tasks: [
      makeTask(),
      makeTask({
        id: "task-2",
        hostname: "another-directory.example.com",
        wait: {
          wait_reason_code: "REQUIRED_INPUT_MISSING",
          resume_trigger: "Terminal audit only. Missing required fields: Country, LinkedIn URL, Phone Number.",
          resolution_owner: "none",
          resolution_mode: "terminal_audit",
          evidence_ref: "artifact-2.json",
        },
      }),
    ],
    profile: makeProfile({
      country: "United States",
      social_links: {
        linkedin: "https://linkedin.com/company/exactstatement",
      },
      dossier_fields: {
        phone_number: {
          key: "phone_number",
          label: "Phone Number",
          value: "+1-307-555-0100",
          source_type: "user_confirmed",
          confidence: "high",
          verified_at: "2026-04-13T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
          reuse_scope: "promoted_site",
          allowed_for_autofill: true,
        },
      },
    }),
  });

  assert.equal(report.tasks_inspected, 2);
  assert.equal(report.tasks_missing_input, 2);
  assert.deepEqual(
    report.resolved_fields.map((field) => ({ key: field.key, value: field.value, source: field.source })),
    [{ key: "phone_number", value: "+1-307-555-0100", source: "dossier.phone_number" }],
  );
  assert.deepEqual(
    report.auto_resolvable_fields.map((field) => ({ key: field.key, value: field.value })),
    [
      { key: "country", value: "United States" },
      { key: "linkedin_url", value: "https://linkedin.com/company/exactstatement" },
    ],
  );
  assert.deepEqual(
    report.unresolved_fields.map((field) => ({ key: field.key, count: field.count })),
    [
      { key: "state_province", count: 1 },
      { key: "founded_date", count: 1 },
    ],
  );
  assert.equal(report.completeness.core_ready, true);
  assert.equal(report.completeness.flow_ready, false);
  assert.equal(report.user_prompt, undefined);
});

test("summarizeMissingInputPreflight prefers structured missing_fields when present", () => {
  const task = makeTask({
    wait: {
      wait_reason_code: "REQUIRED_INPUT_MISSING",
      resume_trigger: "Terminal audit only. More business info is required.",
      resolution_owner: "none",
      resolution_mode: "terminal_audit",
      evidence_ref: "artifact.json",
      missing_fields: [
        { key: "primary_category", label: "Primary Category" },
        { key: "logo_url", label: "Logo URL" },
      ],
    },
  });

  const report = summarizeMissingInputPreflight({
    tasks: [task],
    profile: makeProfile({
      primary_category: "Finance",
    }),
  });

  assert.deepEqual(
    report.resolved_fields.map((field) => field.key),
    [],
  );
  assert.deepEqual(
    report.auto_resolvable_fields.map((field) => field.key),
    ["primary_category"],
  );
  assert.deepEqual(
    report.unresolved_fields.map((field) => field.key),
    ["logo_url"],
  );
  assert.equal(report.completeness.core_ready, true);
});

test("summarizeMissingInputPreflight reports completeness tiers based on resolved and auto-resolvable coverage", () => {
  const report = summarizeMissingInputPreflight({
    tasks: [
      makeTask({
        wait: {
          wait_reason_code: "REQUIRED_INPUT_MISSING",
          resume_trigger: "Missing required fields: Phone Number, Address, City, Postcode.",
          resolution_owner: "none",
          resolution_mode: "terminal_audit",
          evidence_ref: "artifact.json",
        },
      }),
    ],
    profile: makeProfile({
      dossier_fields: {
        phone_number: {
          key: "phone_number",
          label: "Phone Number",
          value: "+1-307-555-0100",
          source_type: "user_confirmed",
          confidence: "high",
          verified_at: "2026-04-13T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
          reuse_scope: "promoted_site",
          allowed_for_autofill: true,
        },
      },
    }),
  });

  assert.equal(report.completeness.core_ready, true);
  assert.equal(report.completeness.flow_ready, false);
  assert.deepEqual(report.completeness.missing_flow_fields, ["address_line_1", "city", "postal_code", "submitter_first_name", "submitter_last_name"]);
});

test("summarizeMissingInputPreflight uses family-specific completeness instead of directory defaults", () => {
  const report = summarizeMissingInputPreflight({
    tasks: [
      makeTask({
        flow_family: "forum_profile",
        wait: {
          wait_reason_code: "REQUIRED_INPUT_MISSING",
          resume_trigger: "Missing required fields: Contact Name.",
          resolution_owner: "none",
          resolution_mode: "terminal_audit",
          evidence_ref: "artifact.json",
        },
      }),
    ],
    profile: makeProfile(),
  });

  assert.equal(report.completeness.core_ready, true);
  assert.equal(report.completeness.flow_ready, true);
  assert.deepEqual(report.completeness.missing_flow_fields, []);
});

test("extractMissingInputFields recognizes forum, comment, and article field schemas", () => {
  const fields = extractMissingInputFields([
    "Missing required fields: Profile Signature, Profile Website URL, Comment Author Name, Comment Body, Article Title, Canonical URL.",
  ]);

  assert.deepEqual(fields.map((field) => field.key), [
    "profile_signature",
    "profile_website_url",
    "comment_author_name",
    "comment_body",
    "article_title",
    "canonical_url",
  ]);
});

test("summarizeMissingInputPreflight resolves dossier-backed multi-family fields", () => {
  const report = summarizeMissingInputPreflight({
    tasks: [
      makeTask({
        flow_family: "forum_profile",
        wait: {
          wait_reason_code: "REQUIRED_INPUT_MISSING",
          resume_trigger: "Missing required fields: Profile Signature, Profile Website URL.",
          resolution_owner: "none",
          resolution_mode: "terminal_audit",
          evidence_ref: "artifact.json",
        },
      }),
    ],
    profile: makeProfile({
      dossier_fields: {
        profile_signature: {
          key: "profile_signature",
          label: "Profile Signature",
          value: "Exact Statement — convert bank statement PDFs to CSV.",
          source_type: "user_confirmed",
          confidence: "high",
          verified_at: "2026-04-16T00:00:00.000Z",
          updated_at: "2026-04-16T00:00:00.000Z",
          reuse_scope: "promoted_site",
          allowed_for_autofill: true,
        },
        profile_website_url: {
          key: "profile_website_url",
          label: "Profile Website URL",
          value: "https://exactstatement.com/",
          source_type: "user_confirmed",
          confidence: "high",
          verified_at: "2026-04-16T00:00:00.000Z",
          updated_at: "2026-04-16T00:00:00.000Z",
          reuse_scope: "promoted_site",
          allowed_for_autofill: true,
        },
      },
    }),
  });

  assert.deepEqual(report.resolved_fields.map((field) => field.key), ["profile_signature", "profile_website_url"]);
  assert.equal(report.unresolved_fields.length, 0);
});

test("summarizeMissingInputPreflight excludes policy-sensitive unresolved fields from ask prompt", () => {
  const report = summarizeMissingInputPreflight({
    tasks: [
      makeTask({
        wait: {
          wait_reason_code: "REQUIRED_INPUT_MISSING",
          resume_trigger: "Missing required fields: Relationship to the Business, Phone Number.",
          resolution_owner: "none",
          resolution_mode: "terminal_audit",
          evidence_ref: "artifact.json",
        },
      }),
    ],
    profile: makeProfile(),
  });

  assert.match(report.user_prompt ?? "", /Phone Number/);
  assert.doesNotMatch(report.user_prompt ?? "", /Relationship to the Business/);
});
