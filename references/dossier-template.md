# Dossier / Submitter Defaults Template

用途：在正式开跑任何单站 submission 或 queue/batch drain 之前，先把 promoted profile、submitter defaults、缺失字段治理口径固定下来。

核心原则：
- 先过 missing-input preflight，再正式提交。
- `unresolved_fields` 里凡是 `recommended_resolution=ask_user_once` 的字段，先一次性向用户要全套，再开跑。
- 不要一边已知缺字段，一边继续正式提交任务。
- 不要用随机伪造身份去补真实站点要求的联系人资料。

## Run gate（正式开跑前必做）

```bash
corepack pnpm missing-input-preflight -- --promoted-url <PROMOTED_URL>
```

处理规则：
1. `unresolved_fields` 为空：可以继续。
2. `unresolved_fields` 非空，且包含 `ask_user_once`：停止，向用户一次性索取整套缺失字段。
3. `unresolved_fields` 只包含 policy / external prerequisite：先说明阻塞项，再决定是否继续该站点。

## Template

```yaml
promoted_profile:
  url: https://exactstatement.com/
  hostname: exactstatement.com
  name: Exact Statement
  company_name: Exact Statement
  description: >-
    Convert bank statement PDFs to CSV and Excel files ready to import into
    QuickBooks Online and Xero. Fast, accurate, and secure bank statement converter.
  tagline: Bank Statement Converter — PDF to CSV & Excel for QBO & Xero
  long_description: >-
    Exact Statement helps finance teams, bookkeepers, and accountants convert bank
    statement PDFs into structured CSV and Excel files for reconciliation and import
    into QuickBooks Online and Xero.
  category_hints:
    - finance
    - accounting
    - productivity
    - automation
  feature_bullets:
    - Convert bank statement PDFs to CSV and Excel
    - Ready for QuickBooks Online and Xero workflows
    - Reduce manual bookkeeping data entry
  contact_email: support@exactstatement.com
  country: <user_confirmed>
  state_province: <user_confirmed>
  city: <user_confirmed_if_needed>
  postal_code: <user_confirmed_if_needed>
  address_line_1: <user_confirmed_if_needed>
  founded_date: <user_confirmed_if_needed>
  social_links:
    twitter: <optional>
    linkedin: <optional>
    youtube: <optional>
  screenshot_assets:
    primary_product_screenshot: <real_image_path_or_url>
    logo: <optional_real_asset>

submitter_defaults:
  submitter_email_base: support@exactstatement.com
  submitter_full_name: <user_confirmed_if_needed>
  contact_first_name: <user_confirmed_if_needed>
  contact_last_name: <user_confirmed_if_needed>
  phone_number: <user_confirmed_if_needed>
  relationship_to_business: <policy_sensitive_if_site_requires>
  role_title: <optional_truthful_role>
  mailbox_resource: Google Workspace / Gmail / other
  oauth_allowed: true
  magic_link_allowed: true

conditional_fields:
  supported_app_store_listing_url: <only_if_truthfully_exists>
  backlink_url: <only_if_campaign_allows_and_truthfully_exists>
  funding_stage: <only_if_user_wants_to disclose>
  twitter_handle: <optional>
  competitor_list: <only_if_user_wants_to disclose>
```

## Field classes

### A. 可以默认长期沉淀的稳定 dossier
- `url`
- `hostname`
- `name`
- `company_name`
- `description`
- `tagline`
- `long_description`
- `category_hints`
- `feature_bullets`
- `contact_email`
- `country`
- `state_province`
- `founded_date`

### B. 正式提交前常见需要用户一次性确认的字段
- `submitter_full_name`
- `contact_first_name`
- `contact_last_name`
- `phone_number`
- `address_line_1`
- `city`
- `postal_code`

### C. 只在确有其事时才可填写
- `supported_app_store_listing_url`
- `backlink_url`
- `funding_stage`
- `competitor_list`
- `publishing_image_urls`

## 禁止事项
- 不要用随机姓名/电话/地址去提交真实站点表单。
- 不要把占位测试数据落到真实第三方目录。
- 不要把品牌信息和 submitter identity 混为一谈。

## 推荐工作法
- 先维护一个“truthful, privacy-safe submitter defaults”包。
- 之后每次先跑 `missing-input-preflight`。
- 若缺字段，统一问一次；补齐后再批量开跑。
