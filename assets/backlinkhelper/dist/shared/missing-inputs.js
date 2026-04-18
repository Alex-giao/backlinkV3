import { getFamilyConfig, resolveFlowFamily } from "../families/index.js";
const MISSING_INPUT_FIELD_DEFINITIONS = [
    {
        key: "postal_code",
        label: "Postal Code",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bpostal code\b/i, /\bpostcode\b/i, /\bzip code\b/i, /\bzip\b/i],
    },
    {
        key: "address_line_1",
        label: "Address Line 1",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\baddress line 1\b/i, /\bstreet address\b/i, /\baddress\b/i],
    },
    {
        key: "city",
        label: "City",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\btown\s*\/\s*city\b/i, /\bcity\s*\/\s*location\b/i, /\blocality\b/i, /\bcity\b/i],
    },
    {
        key: "phone_number",
        label: "Phone Number",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bmain phone number\b/i, /\bphone number\b/i, /\btelephone\b/i, /\bphone\b/i],
    },
    {
        key: "country",
        label: "Country",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\bcountry\b/i],
    },
    {
        key: "state_province",
        label: "State / Province",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\bstate\s*\/\s*province\b/i, /\bstate or province\b/i, /\bprovince\b/i],
    },
    {
        key: "founded_date",
        label: "Founded Date",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\bfounded date\b/i, /\bdate founded\b/i],
    },
    {
        key: "primary_category",
        label: "Primary Category",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\bprimary category\b/i, /\bcategory\b/i],
    },
    {
        key: "logo_url",
        label: "Logo URL",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\blogo url\b/i, /\blogo\b/i],
    },
    {
        key: "linkedin_url",
        label: "LinkedIn URL",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\blinkedin url\b/i, /\blinkedin\b/i],
    },
    {
        key: "youtube_url",
        label: "YouTube URL",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\byoutube url\b/i, /\byoutube\b/i],
    },
    {
        key: "company_name",
        label: "Company Name",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\bcompany name\b/i],
    },
    {
        key: "contact_email",
        label: "Contact Email",
        field_class: "public_factual",
        ask_priority: "medium",
        recommended_resolution: "backfill_from_dossier",
        patterns: [/\bcontact email\b/i, /\bsupport email\b/i, /\bemail\b/i],
    },
    {
        key: "contact_name",
        label: "Contact Name",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcontact person\b/i, /\bcontact name\b/i],
    },
    {
        key: "contact_first_name",
        label: "Contact First Name",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcontact first name\b/i, /\bfirst name\b/i],
    },
    {
        key: "contact_last_name",
        label: "Contact Last Name",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcontact last name\b/i, /\blast name\b/i],
    },
    {
        key: "submitter_first_name",
        label: "Submitter First Name",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bsubmitter first name\b/i],
    },
    {
        key: "submitter_last_name",
        label: "Submitter Last Name",
        field_class: "operator_default",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bsubmitter last name\b/i],
    },
    {
        key: "backlink_url",
        label: "Backlink URL",
        field_class: "external_prerequisite",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bbacklink url\b/i, /\blive backlink\b/i],
    },
    {
        key: "supported_app_store_listing_url",
        label: "Supported App Store Listing URL",
        field_class: "external_prerequisite",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bsupported app store listing url\b/i, /\bapp store listing url\b/i],
    },
    {
        key: "funding_stage",
        label: "Funds Received To Date",
        field_class: "external_prerequisite",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bfunds received to date\b/i, /\bfunding stage\b/i],
    },
    {
        key: "relationship_to_business",
        label: "Relationship to the Business",
        field_class: "policy_sensitive",
        ask_priority: "high",
        recommended_resolution: "needs_policy_decision",
        patterns: [/\brelationship to the business\b/i, /\bauthorized representative\b/i],
    },
    {
        key: "profile_display_name",
        label: "Profile Display Name",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bprofile display name\b/i, /\bdisplay name\b/i],
    },
    {
        key: "profile_headline",
        label: "Profile Headline",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bprofile headline\b/i, /\bheadline\b/i],
    },
    {
        key: "profile_bio",
        label: "Profile Bio",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bprofile bio\b/i, /\babout me\b/i],
    },
    {
        key: "profile_signature",
        label: "Profile Signature",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bprofile signature\b/i, /\bsignature\b/i],
    },
    {
        key: "profile_website_url",
        label: "Profile Website URL",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bprofile website url\b/i, /\bwebsite url\b/i],
    },
    {
        key: "profile_social_links",
        label: "Profile Social Links",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bprofile social links\b/i, /\bsocial links\b/i],
    },
    {
        key: "comment_author_name",
        label: "Comment Author Name",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcomment author name\b/i, /\bauthor name\b/i],
    },
    {
        key: "comment_author_email",
        label: "Comment Author Email",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcomment author email\b/i, /\bauthor email\b/i],
    },
    {
        key: "comment_author_url",
        label: "Comment Author URL",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcomment author url\b/i, /\bauthor url\b/i],
    },
    {
        key: "comment_body",
        label: "Comment Body",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcomment body\b/i, /\bcomment text\b/i],
    },
    {
        key: "comment_format_strategy",
        label: "Comment Format Strategy",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcomment format strategy\b/i, /\bcomment format\b/i, /\bbbcode\b/i, /\bhtml link\b/i],
    },
    {
        key: "article_title",
        label: "Article Title",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\barticle title\b/i],
    },
    {
        key: "article_summary",
        label: "Article Summary",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\barticle summary\b/i],
    },
    {
        key: "article_body_or_markdown",
        label: "Article Body / Markdown",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\barticle body\b/i, /\barticle markdown\b/i, /\bmarkdown\b/i],
    },
    {
        key: "author_bio_short",
        label: "Author Bio (Short)",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bauthor bio\b/i, /\bshort author bio\b/i],
    },
    {
        key: "canonical_url",
        label: "Canonical URL",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\bcanonical url\b/i],
    },
    {
        key: "tags_or_categories",
        label: "Tags / Categories",
        field_class: "site_specific",
        ask_priority: "high",
        recommended_resolution: "ask_user_once",
        patterns: [/\btags or categories\b/i, /\btags\b/i],
    },
];
function normalizeStructuredField(field) {
    const definition = findFieldDefinition(field.key) ?? findFieldDefinitionForText(field.label);
    if (!definition) {
        return field;
    }
    return definitionToMissingField(definition, {
        ...field,
        key: definition.key,
        label: definition.label,
        site_label: field.site_label ?? (field.label !== definition.label ? field.label : undefined),
        source_hint: field.source_hint ?? "structured_missing_fields",
        confidence: field.confidence ?? "high",
        should_ask_user: field.should_ask_user ?? definition.recommended_resolution === "ask_user_once",
        ask_priority: field.ask_priority ?? definition.ask_priority,
        recommended_resolution: field.recommended_resolution ?? definition.recommended_resolution,
    });
}
function uniqueFields(fields) {
    const seen = new Set();
    const result = [];
    for (const rawField of fields) {
        const field = normalizeStructuredField(rawField);
        const normalizedKey = field.key.trim().toLowerCase();
        if (!normalizedKey || seen.has(normalizedKey)) {
            continue;
        }
        seen.add(normalizedKey);
        result.push(field);
    }
    return result;
}
function findFieldDefinition(key) {
    return MISSING_INPUT_FIELD_DEFINITIONS.find((definition) => definition.key === key);
}
function findFieldDefinitionForText(text) {
    const normalized = text.trim();
    if (!normalized) {
        return undefined;
    }
    return MISSING_INPUT_FIELD_DEFINITIONS.find((definition) => definition.key === normalized.toLowerCase() || definition.patterns.some((pattern) => pattern.test(normalized)));
}
export function lookupMissingInputFieldDefinition(keyOrLabel) {
    return findFieldDefinition(keyOrLabel.trim().toLowerCase()) ?? findFieldDefinitionForText(keyOrLabel);
}
function defaultParsedConfidence() {
    return "medium";
}
function definitionToMissingField(definition, overrides = {}) {
    return {
        key: definition.key,
        label: definition.label,
        field_class: definition.field_class,
        source_hint: overrides.source_hint ?? "parsed_from_text",
        confidence: overrides.confidence ?? defaultParsedConfidence(),
        should_ask_user: overrides.should_ask_user ?? definition.recommended_resolution === "ask_user_once",
        ask_priority: overrides.ask_priority ?? definition.ask_priority,
        recommended_resolution: overrides.recommended_resolution ?? definition.recommended_resolution,
        ...overrides,
    };
}
function labelizeCategoryHint(value) {
    return value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
function resolveKnownProfileValue(profile, key) {
    const dossierField = profile.dossier_fields?.[key];
    const definition = findFieldDefinition(key);
    const label = definition?.label ?? key;
    if (dossierField?.value && dossierField.allowed_for_autofill) {
        return {
            field: {
                key,
                label,
                value: dossierField.value,
                source: `dossier.${key}`,
            },
            mode: "resolved",
        };
    }
    switch (key) {
        case "country":
            return profile.country
                ? { field: { key, label: "Country", value: profile.country, source: "profile.country" }, mode: "auto_resolvable" }
                : undefined;
        case "state_province":
            return profile.state_province
                ? {
                    field: { key, label: "State / Province", value: profile.state_province, source: "profile.state_province" },
                    mode: "auto_resolvable",
                }
                : undefined;
        case "founded_date":
            return profile.founded_date
                ? {
                    field: { key, label: "Founded Date", value: profile.founded_date, source: "profile.founded_date" },
                    mode: "auto_resolvable",
                }
                : undefined;
        case "primary_category": {
            const value = profile.primary_category ?? profile.category_hints[0];
            return value
                ? {
                    field: {
                        key,
                        label: "Primary Category",
                        value: profile.primary_category ?? labelizeCategoryHint(value),
                        source: profile.primary_category ? "profile.primary_category" : "profile.category_hints[0]",
                    },
                    mode: "auto_resolvable",
                }
                : undefined;
        }
        case "logo_url":
            return profile.logo_url
                ? { field: { key, label: "Logo URL", value: profile.logo_url, source: "profile.logo_url" }, mode: "auto_resolvable" }
                : undefined;
        case "linkedin_url":
            return profile.social_links?.linkedin
                ? {
                    field: {
                        key,
                        label: "LinkedIn URL",
                        value: profile.social_links.linkedin,
                        source: "profile.social_links.linkedin",
                    },
                    mode: "auto_resolvable",
                }
                : undefined;
        case "youtube_url":
            return profile.social_links?.youtube
                ? {
                    field: {
                        key,
                        label: "YouTube URL",
                        value: profile.social_links.youtube,
                        source: "profile.social_links.youtube",
                    },
                    mode: "auto_resolvable",
                }
                : undefined;
        case "company_name": {
            const value = profile.company_name ?? profile.name;
            return value
                ? {
                    field: {
                        key,
                        label: "Company Name",
                        value,
                        source: profile.company_name ? "profile.company_name" : "profile.name",
                    },
                    mode: "auto_resolvable",
                }
                : undefined;
        }
        case "contact_email":
            return profile.contact_email
                ? {
                    field: {
                        key,
                        label: "Contact Email",
                        value: profile.contact_email,
                        source: "profile.contact_email",
                    },
                    mode: "auto_resolvable",
                }
                : undefined;
        default:
            return undefined;
    }
}
export function extractMissingInputFields(texts) {
    const combined = texts
        .filter((value) => Boolean(value && value.trim()))
        .join("\n");
    if (!combined.trim()) {
        return [];
    }
    const detected = MISSING_INPUT_FIELD_DEFINITIONS.filter((definition) => definition.patterns.some((pattern) => pattern.test(combined))).map((definition) => definitionToMissingField(definition, {
        source_hint: "parsed_from_text",
        confidence: defaultParsedConfidence(),
        should_ask_user: definition.recommended_resolution === "ask_user_once",
    }));
    return uniqueFields(detected);
}
function collectTaskMissingFields(task) {
    if (task.wait?.missing_fields?.length) {
        return uniqueFields(task.wait.missing_fields);
    }
    return extractMissingInputFields([
        task.wait?.resume_trigger,
        task.last_takeover_outcome,
        ...task.notes.slice(-5),
    ]);
}
function isMissingInputTask(task) {
    return task.status === "WAITING_MISSING_INPUT" || task.wait?.wait_reason_code === "REQUIRED_INPUT_MISSING";
}
function resolvePreflightFamilyConfig(tasks) {
    const families = [...new Set(tasks.map((task) => resolveFlowFamily(task.flow_family)))];
    const flowFamily = families.length === 1 ? families[0] : resolveFlowFamily(undefined);
    return getFamilyConfig(flowFamily);
}
function buildCompleteness(args) {
    const familyConfig = resolvePreflightFamilyConfig(args.tasks);
    const { core_ready_fields, flow_ready_fields, conditional_ready_fields } = familyConfig.completeness;
    const missingCoreFields = core_ready_fields.filter((key) => !args.availableKeys.has(key));
    const missingFlowFields = flow_ready_fields.filter((key) => !args.availableKeys.has(key));
    const missingConditionalFields = conditional_ready_fields.filter((key) => !args.availableKeys.has(key));
    return {
        core_ready: missingCoreFields.length === 0,
        flow_ready: missingFlowFields.length === 0,
        conditional_ready: missingConditionalFields.length === 0,
        missing_core_fields: [...missingCoreFields],
        missing_flow_fields: [...missingFlowFields],
        missing_conditional_fields: [...missingConditionalFields],
    };
}
export function summarizeMissingInputPreflight(args) {
    const relevantTasks = args.tasks.filter((task) => isMissingInputTask(task));
    const fieldSummary = new Map();
    for (const task of relevantTasks) {
        for (const field of collectTaskMissingFields(task)) {
            const existing = fieldSummary.get(field.key);
            if (existing) {
                existing.count += 1;
                if (!existing.example_task_ids.includes(task.id)) {
                    existing.example_task_ids.push(task.id);
                }
                if (!existing.example_hostnames.includes(task.hostname)) {
                    existing.example_hostnames.push(task.hostname);
                }
                continue;
            }
            fieldSummary.set(field.key, {
                ...field,
                count: 1,
                example_task_ids: [task.id],
                example_hostnames: [task.hostname],
            });
        }
    }
    const resolvedFields = [];
    const autoResolvableFields = [];
    const unresolvedFields = [];
    for (const field of fieldSummary.values()) {
        const resolved = args.profile ? resolveKnownProfileValue(args.profile, field.key) : undefined;
        if (resolved?.mode === "resolved") {
            resolvedFields.push(resolved.field);
        }
        else if (resolved?.mode === "auto_resolvable") {
            autoResolvableFields.push(resolved.field);
        }
        else {
            unresolvedFields.push(field);
        }
    }
    const sortByPriority = (left, right) => {
        const leftIndex = MISSING_INPUT_FIELD_DEFINITIONS.findIndex((definition) => definition.key === left.key);
        const rightIndex = MISSING_INPUT_FIELD_DEFINITIONS.findIndex((definition) => definition.key === right.key);
        if (leftIndex !== rightIndex) {
            return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        }
        return left.label.localeCompare(right.label);
    };
    resolvedFields.sort(sortByPriority);
    autoResolvableFields.sort(sortByPriority);
    unresolvedFields.sort((left, right) => {
        if (right.count !== left.count) {
            return right.count - left.count;
        }
        return sortByPriority(left, right);
    });
    const unresolvedAskLabels = unresolvedFields
        .filter((field) => field.should_ask_user !== false)
        .map((field) => field.label);
    const prompt = unresolvedAskLabels.length > 0
        ? `Before the next operator run, please provide these submission defaults for ${args.profile?.name ?? args.profile?.hostname ?? "the promoted site"}: ${unresolvedAskLabels.join("; ")}.`
        : undefined;
    const availableKeys = new Set([
        ...resolvedFields.map((field) => field.key),
        ...autoResolvableFields.map((field) => field.key),
    ]);
    if (args.profile?.company_name || args.profile?.name) {
        availableKeys.add("company_name");
    }
    if (args.profile?.contact_email) {
        availableKeys.add("contact_email");
    }
    if (args.profile?.primary_category || args.profile?.category_hints?.length) {
        availableKeys.add("primary_category");
    }
    return {
        promoted_hostname: args.profile?.hostname,
        tasks_inspected: args.tasks.length,
        tasks_missing_input: relevantTasks.length,
        resolved_fields: resolvedFields,
        auto_resolvable_fields: autoResolvableFields,
        unresolved_fields: unresolvedFields,
        completeness: buildCompleteness({ profile: args.profile, availableKeys, tasks: relevantTasks }),
        user_prompt: prompt,
    };
}
export function enrichWaitMetadataWithMissingFields(task) {
    if (!task.wait || task.wait.wait_reason_code !== "REQUIRED_INPUT_MISSING" || task.wait.missing_fields?.length) {
        return task;
    }
    const parsed = collectTaskMissingFields(task);
    if (parsed.length === 0) {
        return task;
    }
    return {
        ...task,
        wait: {
            ...task.wait,
            missing_fields: parsed,
        },
    };
}
