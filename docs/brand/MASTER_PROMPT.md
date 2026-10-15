# TYPEASE — COMPLETE AI DEVELOPMENT MASTER PROMPT
## Build a Production-Ready, Multi-Tenant, White-Label Typing Centre Management SaaS

You are an autonomous senior software engineering team consisting of a product architect, UX/UI designer, frontend engineer, backend engineer, Flutter engineer, database architect, DevOps engineer, security engineer, QA engineer and technical writer.

Your task is to design, implement, integrate, test, secure and document a COMPLETE commercial SaaS product named **TypEase**.

**Tagline:** Typing Made Easy.

The software is intended for UAE typing centres, document-clearing companies, PRO service providers and related business service centres.

The entire product must be built by the AI coding agent. Do not assume the project owner will manually implement missing modules, create database tables, connect APIs, fix errors or complete unfinished workflows.

Do not stop after producing a prototype, UI mockup, skeleton, or partial implementation.

Build the full system in one coordinated project. You may organise your internal implementation into manageable tasks, but the final deliverable must be a complete, integrated application, not a series of incomplete phases.

Do not falsely claim functionality that has not been implemented or tested.

When external credentials, payment accounts, government approvals or other third-party dependencies are unavailable, implement the complete integration interface, configuration screens, test adapters and clearly documented activation requirements. Never invent credentials, live connections or successful external submissions.

---

# 1. PRODUCT VISION

TypEase is a centralised cloud platform that enables typing centres to manage their entire business.

It must handle:

- Customer registration and profiles
- Walk-in and online service requests
- Service catalogues
- Visa and immigration assistance workflows
- Emirates ID assistance workflows
- Labour and employment document assistance
- Business and PRO services
- Document preparation, printing and scanning
- Customer document uploads
- AI-assisted document extraction
- Staff assignments and approvals
- Application and case tracking
- Quotations, invoices, payments and refunds
- Government and third-party fee accounting
- Corporate customer accounts
- Employee and document expiry tracking
- Automated reminders
- WhatsApp, SMS and email notifications
- Appointments and queue management
- Customer support
- Branch management
- Financial reporting
- SaaS subscriptions
- White-label branding
- Secure tenant isolation
- Platform administration

Every module must connect to the others using the same database, business rules, authentication and audit system.

The platform must work for both a single typing centre and a company operating multiple branches.

It must also support multiple independent typing centre companies subscribing to the same SaaS without exposing one company's data to another.

---

# 2. BRANDING AND DESIGN SYSTEM

Use the attached TypEase logo and branding mockup as the official design references.

Brand:
- Name: TypEase
- Tagline: Typing Made Easy.
- Primary colour: Deep navy
- Secondary colour: Bright blue
- Accent colour: Emerald green
- Background: White and very light grey
- Font: Inter or another clean, readable modern font
- Design style: Premium, minimal, professional, accessible

Extract the exact brand colours from the supplied logo where possible and define them as reusable design tokens.

Create a centralised theme system for all applications.

Support:
- Light theme
- Dark theme
- English
- Arabic with complete RTL support
- Responsive desktop, tablet and mobile layouts
- White-label theme overrides

Do not use excessive gradients, decorative animations, complex navigation or unnecessarily crowded screens.

UI principles:
1. One clear primary action per screen.
2. Simple navigation and understandable labels.
3. Display only relevant fields.
4. Use step-by-step forms for complex services.
5. Show progress and next actions clearly.
6. Save unfinished forms as drafts.
7. Avoid forcing users to re-enter existing information.
8. Provide useful validation and error messages.
9. Support keyboard navigation.
10. Ensure accessibility and sufficient contrast.

Create reusable UI components including buttons, inputs, forms, tables, filters, modals, status badges, timelines, file viewers, confirmation dialogs, notifications, empty states, skeleton loaders and pagination.

---

# 3. REQUIRED TECHNOLOGY STACK

Use a clean monorepo.

Frontend:
- Next.js with TypeScript
- React
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod
- Reusable component architecture

Backend:
- NestJS
- TypeScript
- REST APIs with OpenAPI/Swagger
- Prisma ORM
- PostgreSQL
- Redis
- BullMQ for background jobs
- WebSockets or Server-Sent Events for relevant live updates

Mobile:
- Flutter
- Riverpod for state management
- GoRouter for navigation
- Dio for API communication
- Secure token storage
- Android and iOS support

Storage:
- S3-compatible private object storage
- Presigned upload/download URLs
- Encryption and access-controlled document retrieval

Automation:
- n8n for selected workflow orchestration
- Backend job queues for critical processing
- Provider abstraction for email, SMS and WhatsApp

Payments:
- Pluggable UAE-compatible payment gateway adapter
- Manual cash/card/bank-transfer recording
- Payment webhook processing
- Refund and reconciliation modules

Testing:
- Jest or Vitest
- Supertest
- Playwright
- Flutter unit and integration tests
- Database integration tests
- Security and tenant-isolation tests

Infrastructure:
- Docker
- Docker Compose
- Environment-based configuration
- CI/CD workflows
- Structured logging
- Health checks
- Database migrations
- Backup and recovery procedures

Use compatible stable package versions and document exact versions.

---

# 4. MONOREPO STRUCTURE

Create:

typease/
  apps/
    platform-admin/
    centre-web/
    customer-web/
    customer-mobile/
    corporate-portal/
  services/
    api/
    worker/
  packages/
    ui/
    types/
    validation/
    config/
    branding/
    api-client/
    permissions/
  infrastructure/
    docker/
    deployment/
    monitoring/
  database/
    prisma/
    migrations/
    seed/
  docs/
    architecture/
    api/
    workflows/
    security/
    deployment/
    user-guides/
  tests/
    e2e/
    integration/
    security/
  scripts/

Keep shared business logic in appropriate backend services rather than duplicating it across applications.

---

# 5. MULTI-TENANT ARCHITECTURE

TypEase must support independent subscribing businesses called tenants.

Each tenant can have:
- Its own business identity
- Multiple branches
- Multiple employees
- Its own customers
- Its own service catalogue
- Its own prices
- Its own invoices
- Its own payment configurations
- Its own documents
- Its own notification templates
- Its own reports
- Its own branding
- Its own custom domain
- Its own subscription

Use a shared PostgreSQL database with strict tenant isolation as the default deployment model.

Every tenant-owned record must have a tenant identifier.

Enforce tenant scope in the backend, not only in the frontend.

Use PostgreSQL Row-Level Security where appropriate, supported by application-level authorisation and carefully controlled database roles.

Never accept an arbitrary tenant ID from a client as proof of authorisation.

Every request must derive the permitted tenant context from verified authentication, memberships and domain routing.

Test cross-tenant access attempts for every sensitive resource.

Platform administrators must not automatically receive unrestricted access to customer documents.

Provide an explicitly authorised, time-limited support access mechanism with approval, logging and reason capture.

Optional enterprise deployment modes may include a dedicated database or dedicated infrastructure per tenant.

Do not claim every tenant has a separate database when using shared-database isolation.

---

# 6. USER ROLES AND PERMISSIONS

Implement configurable role-based access control with resource-level and action-level permissions.

Required roles:

## Platform Super Admin

Can:
- Manage SaaS tenants
- Manage subscriptions and plans
- View platform-level metrics
- Configure global features
- Manage billing
- Manage approved integrations
- Manage platform staff
- View audit and security events
- Suspend tenants
- Handle support requests

Cannot freely access tenant customer documents.

## Platform Support Agent

Can:
- View tenant subscription information
- Handle support tickets
- Diagnose platform configuration issues
- Access approved troubleshooting metadata

Sensitive tenant data access requires explicit authorisation.

## Typing Centre Owner

Can:
- Manage the centre
- Manage branches
- Invite employees
- Configure services
- Set prices
- Manage customer requests
- Approve discounts and refunds
- Manage finances
- View reports
- Configure branding
- Manage corporate clients
- Manage notification settings

## Centre Manager

Can manage assigned branches, employees, cases, schedules and operational reports within granted permissions.

## Receptionist

Can:
- Register customers
- Create service requests
- Upload documents
- Generate quotations
- Receive permitted payments
- Print receipts
- Schedule appointments

Cannot access restricted financial settings or platform administration.

## Typing Operator

Can:
- View assigned requests
- Verify documents
- Prepare applications
- Record submission references
- Update permitted case statuses
- Request missing information
- Upload completed documents

Cannot approve their own restricted financial adjustments.

## Document Reviewer

Can:
- Review submitted documents
- Validate extracted data
- Approve or reject document verification
- Record correction requests
- Send cases back to operators

## Accountant

Can:
- Manage invoices
- Reconcile payments
- Track government fee liabilities
- Record expenses
- Manage credit notes
- Generate financial reports

## Customer

Can:
- Register and log in
- Manage personal profile
- Request services
- Upload documents
- Receive quotations
- Pay invoices
- Track applications
- Download authorised documents
- Contact support
- View history
- Manage notifications and privacy requests

## Corporate Administrator

Can manage the corporate account, authorised employee records, company service requests, invoices, approval requests and renewal reminders.

## Corporate Employee

Can access only their own records and requests where authorised.

Create a permissions matrix and enforce it on every relevant API endpoint.

---

# 7. AUTHENTICATION AND ACCOUNT MANAGEMENT

Implement:
- Email and password login
- Phone OTP login through a configured provider
- Email verification
- Password reset
- MFA for privileged accounts
- Session management
- Refresh token rotation
- Device/session revocation
- Login activity history
- Rate limiting
- Account lockout protections
- Secure invitation flow
- Role-based redirects
- Tenant-aware login
- Custom-domain login
- Optional approved SSO integration

Never store plaintext passwords, OTPs or sensitive authentication tokens.

Use strong password hashing, secure cookies where applicable and short-lived access tokens.

---

# 8. PLATFORM ADMIN MODULE

Create a separate TypEase SaaS administration application.

Dashboard must show:
- Total tenants
- Active tenants
- Trial tenants
- Suspended tenants
- Monthly recurring revenue
- Annual recurring revenue
- Subscription churn
- Failed payments
- Storage usage
- Notification usage
- System health
- Support tickets

Tenant onboarding workflow:

1. New typing centre signs up.
2. Owner verifies email and phone.
3. Business information is collected.
4. Owner selects subscription plan.
5. Payment or trial eligibility is verified.
6. Tenant workspace is provisioned.
7. Owner chooses branding.
8. Owner configures services and branches.
9. Owner invites staff.
10. Centre becomes operational.

Include onboarding progress and resumable drafts.

Platform administrators must be able to review and approve tenants where required.

Provide tenant suspension, reactivation, archival and controlled offboarding.

---

# 9. SUBSCRIPTION AND SAAS BILLING

Implement configurable plans.

Suggested initial plan structure:
- Starter
- Professional
- Business
- Enterprise

Do not hardcode pricing into business logic.

Plans must support configurable limits for:
- Branches
- Staff users
- Monthly requests
- Storage
- AI processing
- Notifications
- Corporate clients
- White-label features
- API access
- Custom domains

Implement:
- Monthly and annual billing
- Trial periods
- Subscription upgrades
- Downgrades
- Proration where supported
- Payment failure handling
- Grace periods
- Invoice generation
- Coupon codes
- Usage tracking
- Plan enforcement
- Cancellation
- Renewal reminders
- Billing history

Ensure subscription billing is completely separate from customer service-request payments.

---

# 10. TYPING CENTRE DASHBOARD

Create a simple operational dashboard.

Show:
- New requests
- Pending document verification
- Awaiting customer information
- Awaiting payment
- Ready for processing
- In progress
- Completed today
- Overdue cases
- Today's service revenue
- Outstanding receivables
- Staff workload
- Upcoming expiries
- Recent activity

Main actions:
- New Request
- Add Customer
- Search Customer
- Upload Document
- Create Invoice
- Assign Case
- View Pending Tasks

Dashboard widgets must use real database queries, not hardcoded values.

Provide branch filters and date-range filters.

---

# 11. CUSTOMER MANAGEMENT MODULE

Customer profile fields:
- Unique customer number
- Full name
- Preferred language
- Email
- Phone
- Nationality, when necessary
- Date of birth, when necessary
- Address, when necessary
- Emirates ID details, when necessary
- Passport details, when necessary
- Customer type
- Communication preferences
- Consent records
- Notes
- Tags
- Created date
- Last activity

Avoid collecting sensitive data unless necessary for the service.

Customer detail screen must show:
- Overview
- Service requests
- Documents
- Invoices
- Payments
- Appointments
- Communications
- Expiry reminders
- Support tickets
- Activity history

Support duplicate detection and carefully controlled customer merging.

Never merge records automatically based only on a matching name.

Provide search by customer number, permitted phone number, name and request reference.

Mask sensitive identity numbers in list views.

---

# 12. SERVICE CATALOGUE MODULE

Every tenant must be able to create and manage services.

Default service categories may include:
- Typing and documentation
- Visa assistance
- Residence assistance
- Emirates ID assistance
- Labour and employment document assistance
- Business setup coordination
- PRO services
- Attestation coordination
- Translation coordination
- Printing and scanning
- Corporate document administration
- Other custom services

These are configurable business service categories, not claims of government authorisation.

Each service must contain:
- Name
- Description
- Category
- Internal code
- Required documents
- Eligibility guidance
- Dynamic form fields
- Workflow template
- Estimated internal processing time
- Service charge
- Government fee estimate
- Third-party charge estimate
- Applicable tax configuration
- Required approval
- Available branches
- Assigned staff group
- Online availability
- Visibility
- Active/inactive status

Support configurable document requirements and service forms.

Each service must also have a compliance capability setting:
- Document preparation only
- Coordination through authorised partner
- Direct authorised processing
- Informational only

Do not enable direct government submission unless a verified, permitted integration exists.

---

# 13. SERVICE REQUEST MANAGEMENT

This is the most important module.

Each request must have:
- Unique request number
- Tenant
- Branch
- Customer
- Service
- Assigned staff
- Priority
- Current status
- Submitted date
- Target date
- Document checklist
- Customer instructions
- Internal notes
- Customer-visible updates
- Fee breakdown
- Payment status
- External application reference
- Submission channel
- Completion documents
- Audit history

Standard workflow:

1. Customer or staff selects a service.
2. System loads the relevant form and document checklist.
3. Existing customer information is prefilled.
4. Missing details are requested.
5. Customer uploads documents.
6. Request is saved as a draft.
7. Staff reviews documents.
8. System generates quotation.
9. Customer approves quotation.
10. Payment is collected according to configured policy.
11. Request is assigned to an operator.
12. Operator prepares application.
13. Reviewer approves when required.
14. Authorised operator submits through a permitted channel.
15. Submission reference is recorded.
16. Request enters processing status.
17. Staff records external updates or approved integration updates.
18. Customer is notified of meaningful changes.
19. Completed documents are uploaded.
20. Final review is performed.
21. Request is marked completed.
22. Customer receives secure delivery notification.
23. Invoice and history remain accessible.

Support exceptions:
- Missing documents
- Invalid documents
- Customer correction required
- Payment failure
- Application rejected
- Application returned
- External processing delay
- Customer cancellation
- Refund required
- Duplicate request
- Request reassignment
- Case reopening

Every status change must be validated against the workflow state machine.

Do not allow arbitrary jumps between statuses.

Use database transactions for critical transitions.

---

# 14. DYNAMIC WORKFLOW BUILDER

Create a configurable workflow engine.

Centre owners must be able to select workflow templates and customise permitted operational steps.

Supported step types:
- Customer form
- Document upload
- Staff verification
- Internal approval
- Customer approval
- Quotation
- Payment
- Staff task
- External/manual processing
- Notification
- Document generation
- Completion
- Conditional branch

Workflow rules may depend on:
- Service type
- Branch
- Customer category
- Document completeness
- Payment status
- Assigned team
- Approval result

Implement:
- Workflow versioning
- Draft/published workflow versions
- Safe rollback
- Workflow execution history
- Timeout handling
- Escalation rules
- Retry-safe background tasks

Existing cases must retain their original workflow version unless explicitly migrated.

---

# 15. DOCUMENT MANAGEMENT

Build a secure document vault.

Features:
- Upload PDF, JPG, PNG and approved file types
- Multiple file upload
- Drag-and-drop
- Mobile camera upload
- File categorisation
- Document preview
- File version history
- Expiry date
- Verification status
- Document checklist mapping
- Access permissions
- Download controls
- Secure sharing
- Document deletion and retention rules

Implement:
- File size limits
- Malware scanning
- MIME and file-signature validation
- Encrypted storage
- Randomised storage keys
- Short-lived download links
- Access logging
- Document ownership validation

Never expose raw private storage paths or publicly accessible identity documents.

---

# 16. AI DOCUMENT ASSISTANT

Implement an optional AI-assisted document processing module.

Capabilities:
- OCR extraction
- Passport field extraction
- Emirates ID field extraction
- Trade licence field extraction
- Date recognition
- Document classification
- Missing document detection
- Expiry warnings
- Field mismatch warnings
- Suggested corrections
- Document checklist assistance

Important requirements:

1. AI output must be treated as unverified.
2. Human review is mandatory for sensitive application data.
3. Display confidence and uncertainty.
4. Never fabricate missing document details.
5. Never automatically approve government applications.
6. Never submit to government systems without an authorised integration and required human approval.
7. Use an approved, configurable OCR/AI provider.
8. Do not send customer documents to unapproved AI services.
9. Provide AI usage logs and cost tracking.
10. Allow tenants to disable AI processing.

Implement a human review screen displaying original document fields beside extracted values.

---

# 17. QUOTATIONS, INVOICES AND PAYMENTS

Support:
- Quotations
- Quotation approval
- Invoices
- Receipts
- Credit notes
- Refunds
- Partial payments
- Multiple payment methods
- Outstanding balances
- Corporate billing
- PDF generation
- Email delivery
- Payment reconciliation

Separate financial components:
- Typing centre service fee
- Government fee
- Third-party processing charge
- Applicable tax
- Discount
- Refund

Government fees and third-party charges must not automatically be treated as centre revenue.

Accounting treatment must be configurable and reviewed for the relevant legal arrangements.

Payment workflow:

1. Generate quotation.
2. Customer approves.
3. Create payment request.
4. Customer pays online or staff records an offline payment.
5. Verify payment.
6. Record transaction.
7. Generate receipt.
8. Update request.
9. Notify customer.
10. Reconcile settlement.

Payment webhooks must be signature-verified, idempotent and resistant to replay.

Never store raw payment card details.

Implement separate refund authorisation permissions.

---

# 18. CORPORATE CUSTOMER MODULE

Allow typing centres to register companies as corporate customers.

Company information:
- Company name
- Trade licence information
- Authorised contacts
- Billing information
- Employee directory
- Service agreements
- Contract pricing
- Credit limits where approved
- Payment terms
- Document expiry schedules

Corporate workflow:

1. Company administrator registers or is invited.
2. Centre verifies corporate authorisation.
3. Company uploads authorised employee details.
4. Administrator creates a service request.
5. Required approvals are collected.
6. Centre processes the case.
7. Company tracks progress.
8. Completed documents are delivered securely.
9. Charges are invoiced according to agreement.
10. Renewal reminders are scheduled.

Corporate users must never access unrelated customers or companies.

Employee personal information must be visible only to authorised users.

---

# 19. APPOINTMENT AND QUEUE MANAGEMENT

Implement:
- Branch calendars
- Service appointment slots
- Staff availability
- Walk-in queue
- Token generation
- Appointment confirmation
- Rescheduling
- Cancellation
- Check-in
- No-show tracking
- Queue display mode
- Waiting-time reporting

Do not display sensitive customer information on public queue screens.

---

# 20. STAFF MANAGEMENT

Features:
- Employee invitations
- Branch assignment
- Role assignment
- Permission management
- Staff status
- Work schedules
- Task assignment
- Workload dashboard
- Activity logs
- Performance metrics
- Internal notes
- Escalations

Support automatic assignment by:
- Branch
- Service expertise
- Workload
- Availability
- Priority

Allow manual reassignment with an audit record.

---

# 21. NOTIFICATION SYSTEM

Channels:
- Email
- SMS
- WhatsApp Business Platform
- In-app notifications
- Optional push notifications

Events:
- Account registration
- New request
- Documents missing
- Quotation ready
- Payment requested
- Payment received
- Staff assigned
- Case status changed
- Application completed
- Appointment reminder
- Document expiry approaching
- Subscription renewal
- Support response

Build:
- Template editor
- Language-specific templates
- Tenant-specific branding
- Delivery logs
- Retry queues
- Failure reporting
- Opt-in/opt-out handling
- Rate limits
- Provider configuration

Use official WhatsApp Business APIs and approved templates when required.

Never send sensitive documents as unsecured public links.

---

# 22. DOCUMENT EXPIRY AUTOMATION

Allow authorised users to track:
- Passport expiry
- Emirates ID expiry
- Residence expiry
- Trade licence expiry
- Employment-related document expiry
- Other configured document types

Reminder schedules:
- 90 days
- 60 days
- 30 days
- 15 days
- 7 days
- Custom schedule

Workflow:
1. Save verified expiry date.
2. Create reminder schedule.
3. Check consent and notification preferences.
4. Send reminder.
5. Record delivery result.
6. Offer renewal assistance request.
7. Link new request to existing customer.
8. Stop or update reminders when document is renewed.

Use configurable reminder templates and avoid misleading claims about legal deadlines.

---

# 23. CUSTOMER WEB PORTAL

Build a mobile-first branded customer website.

Public pages:
- Home
- Services
- About
- Contact
- FAQ
- Request tracking
- Login
- Registration
- Privacy policy
- Terms

Logged-in pages:
- Dashboard
- My requests
- New request
- My documents
- Quotations
- Payments
- Appointments
- Messages
- Notifications
- Profile
- Support

Customer onboarding:

1. Open branded portal.
2. Select service.
3. Register or log in.
4. Complete required details.
5. Upload documents.
6. Review request.
7. Submit.
8. Receive confirmation.
9. Follow progress.
10. Pay when required.
11. Download completed documents.

Allow draft saving and resuming across devices.

Do not require customers to upload the same documents repeatedly when existing documents are valid and reusable with appropriate authorisation.

---

# 24. FLUTTER CUSTOMER MOBILE APP

Build a complete Flutter customer application.

Screens:
- Splash
- Onboarding
- Login
- Registration
- OTP verification
- Home
- Service catalogue
- Service details
- New request wizard
- Document upload
- Camera capture
- Request history
- Request details
- Status timeline
- Payment
- Notifications
- Appointments
- Support
- Profile
- Settings

Use the same backend as the web applications.

Support:
- Secure local token storage
- Camera permissions
- File selection
- Push notifications
- Deep links
- Error handling
- Loading states
- Session expiry
- English and Arabic
- White-label runtime configuration

Do not hardcode tenant branding.

The customer app must resolve the selected centre through a verified tenant configuration or invitation.

---

# 25. WHITE-LABEL SYSTEM

This is a major commercial requirement.

Each typing centre must be able to customise:
- Business name
- Logo
- Favicon
- Primary colour
- Secondary colour
- Accent colour
- Website title
- Email sender identity where verified
- Notification templates
- Invoice branding
- Receipt branding
- Customer portal domain
- Public service catalogue

Support:
- TypEase-branded SaaS mode
- Tenant-branded web portal
- Custom domain
- Multi-branch branding
- Branded PDF templates

Custom domains must use verified domain ownership and correctly provisioned TLS certificates.

Never allow one tenant to claim another tenant's domain.

Mobile white-label distribution must account for separate app builds, signing, store accounts and approval requirements where applicable.

Do not pretend changing a database setting automatically publishes a separate iOS or Android application.

---

# 26. REPORTING AND ANALYTICS

Centre reports:
- Daily sales
- Monthly service revenue
- Transactions by service
- Requests by status
- Staff workload
- Branch performance
- Customer growth
- Outstanding payments
- Refunds
- Government fee liabilities
- Corporate revenue
- Service profitability
- Expiry reminders
- Document processing time
- Customer satisfaction

SaaS platform reports:
- Tenant growth
- Subscription revenue
- Plan distribution
- Churn
- Usage
- Storage
- AI processing costs
- Notification costs
- Failed payments

Provide:
- Date filters
- Branch filters
- Export to Excel
- Export to PDF
- Scheduled reports
- Charts
- Drill-down views

Financial dashboards must distinguish gross customer collections from earned service revenue.

---

# 27. SUPPORT AND COMMUNICATION

Build:
- Customer support tickets
- Internal comments
- Customer-visible messages
- Attachments
- Ticket priorities
- Ticket assignments
- Status tracking
- SLA configuration
- Resolution history
- Customer feedback

Allow a service request to have linked support conversations.

Keep internal notes separate from customer-visible communication.

---

# 28. DATABASE DESIGN

Design a properly normalised PostgreSQL schema.

Include at least the following entity groups.

Platform:
- Users
- Sessions
- Tenants
- TenantMemberships
- Roles
- Permissions
- RolePermissions
- Branches
- SubscriptionPlans
- Subscriptions
- SubscriptionInvoices
- UsageRecords
- TenantDomains
- BrandingSettings
- FeatureFlags

Customers:
- Customers
- CustomerContacts
- CustomerConsents
- CustomerNotes
- CustomerTags
- CorporateAccounts
- CorporateMembers
- CorporateEmployees

Services:
- ServiceCategories
- Services
- ServicePrices
- ServiceRequirements
- ServiceFormDefinitions
- WorkflowDefinitions
- WorkflowVersions
- WorkflowSteps

Requests:
- ServiceRequests
- RequestFields
- RequestDocuments
- RequestStatusHistory
- RequestAssignments
- RequestApprovals
- RequestComments
- RequestExternalReferences
- WorkflowExecutions
- WorkflowStepExecutions

Documents:
- Documents
- DocumentVersions
- DocumentAccessLogs
- DocumentVerificationResults
- OCRExtractionResults

Finance:
- Quotations
- QuotationItems
- Invoices
- InvoiceItems
- Payments
- PaymentAllocations
- Refunds
- CreditNotes
- Expenses
- FeeComponents
- ReconciliationRecords

Operations:
- Appointments
- QueueTokens
- Tasks
- TaskAssignments
- Notifications
- NotificationTemplates
- NotificationDeliveries
- ReminderSchedules
- SupportTickets
- SupportMessages

Security:
- AuditLogs
- SecurityEvents
- AccessGrants
- ConsentRecords
- DataRetentionPolicies
- DataDeletionRequests
- IntegrationCredentialsMetadata

Add:
- Proper foreign keys
- Tenant-scoped indexes
- Unique constraints
- Check constraints
- Soft deletion where appropriate
- Created/updated timestamps
- Optimistic concurrency where appropriate
- Financial immutability rules

Use decimal-safe monetary values and ISO currency codes.

Use UTC timestamps in storage and display local time correctly.

---

# 29. API DESIGN

Create documented REST APIs.

Required API groups:
- Authentication
- Users
- Roles
- Tenants
- Branches
- Customers
- Corporate accounts
- Services
- Service forms
- Workflows
- Requests
- Documents
- OCR
- Quotations
- Invoices
- Payments
- Refunds
- Appointments
- Queue
- Tasks
- Notifications
- Reminders
- Reports
- Subscriptions
- Branding
- Integrations
- Support
- Audit logs

Every API must include:
- Authentication where required
- Authorisation
- Tenant isolation
- Validation
- Consistent errors
- Pagination
- Filtering
- Sorting
- Audit handling
- OpenAPI documentation
- Automated tests

Generate typed API clients for frontend and Flutter where practical.

---

# 30. SECURITY REQUIREMENTS

Treat security as mandatory.

Implement:
- Tenant isolation
- Strong authentication
- MFA for privileged roles
- RBAC
- Resource-level authorisation
- Secure session handling
- Encryption in transit
- Encryption at rest
- Secrets management
- Secure document access
- Audit logging
- Rate limiting
- Input validation
- File scanning
- CSRF protection where applicable
- XSS protection
- SQL injection protection
- SSRF protection
- Webhook signature validation
- Idempotency
- Backup encryption
- Restore testing
- Security monitoring

Design privacy controls for UAE personal data requirements.

Implement:
- Privacy notices
- Consent tracking where applicable
- Lawful processing basis records
- Data minimisation
- Configurable retention
- Access requests
- Correction requests
- Deletion requests subject to legal obligations
- Data export
- Incident reporting workflows
- Vendor and processor configuration
- Cross-border processing review

Do not claim legal compliance merely because technical controls exist. Produce a compliance checklist for review by qualified UAE advisers.

Never use real passport or Emirates ID data in demo seeds.

---

# 31. GOVERNMENT SERVICE INTEGRATION POLICY

The system must support UAE government-related assistance workflows without falsely representing itself as an authorised government platform.

Implement integration modes:

1. Manual processing
2. Authorised partner processing
3. Official approved API integration, if available and authorised

For manual processing:
- Staff prepares the case.
- Staff accesses the official portal separately using authorised credentials.
- Staff records the reference and status.
- Staff uploads permitted results.
- Customer receives updates.

For partner processing:
- Record partner identity.
- Send only authorised information securely.
- Track partner reference.
- Record fees and processing status.
- Receive permitted completion documents.

For official API integration:
- Require documented API access.
- Use provider-issued credentials.
- Implement approved authentication.
- Follow API limits.
- Record requests and responses safely.
- Use sandbox testing where offered.

Never implement:
- CAPTCHA bypass
- OTP interception
- Unauthorised government portal automation
- Credential sharing
- Government website scraping that violates applicable rules
- Fake application approvals
- Fabricated government status updates

Clearly label whether a status is:
- Internal TypEase status
- Staff-entered external status
- Partner-provided status
- Verified official integration status

---

# 32. AUTOMATION ENGINE

Implement an event-driven automation system.

Events:
- customer.created
- request.created
- document.uploaded
- document.verified
- quotation.approved
- payment.completed
- request.assigned
- request.status_changed
- request.completed
- document.expiring
- appointment.created
- subscription.renewal_due

Each event may trigger configured actions.

Actions:
- Create task
- Assign staff
- Send notification
- Schedule reminder
- Generate document
- Update internal workflow state
- Request approval
- Create follow-up
- Escalate overdue case

Provide an automation management interface.

Features:
- Enable/disable automation
- Template selection
- Trigger conditions
- Action configuration
- Execution logs
- Retry rules
- Failure alerts
- Dead-letter queue
- Idempotency protection
- Tenant-specific settings

Do not let customer-configured automations bypass permissions or compliance restrictions.

---

# 33. DEMO AND SEED DATA

Create a complete demonstration environment.

Seed:
- One platform administrator
- Three independent sample tenants
- Multiple branches
- Sample staff roles
- Sample customers
- Sample corporate customers
- Sample services
- Sample requests in different statuses
- Sample invoices
- Sample payments
- Sample reminders
- Sample support tickets

All data must be fictional.

Demonstrate strict tenant isolation.

Provide clearly documented demo credentials for local development only.

Never deploy known demo passwords to production.

---

# 34. TESTING REQUIREMENTS

Create automated tests covering all critical workflows.

Required end-to-end scenarios:

1. Platform admin creates a tenant.
2. Tenant owner completes onboarding.
3. Tenant owner creates a branch.
4. Owner invites a staff member.
5. Staff member logs in.
6. Staff creates a customer.
7. Customer submits a service request.
8. Customer uploads documents.
9. Reviewer verifies documents.
10. Quotation is generated.
11. Customer approves quotation.
12. Payment is recorded.
13. Request is assigned.
14. Operator processes request.
15. Request is completed.
16. Customer receives notification.
17. Customer downloads completed document.
18. Corporate customer submits an employee request.
19. Reminder job runs.
20. Invoice is generated.
21. Subscription is upgraded.
22. White-label theme is changed.
23. Custom-domain configuration is validated.
24. Tenant A cannot access Tenant B data.
25. Unauthorised role cannot approve refunds.
26. Duplicate payment webhook does not duplicate payment.
27. Failed notification is retried safely.
28. Expired document download URL is rejected.
29. Deleted or archived customer data is handled according to policy.
30. Reports match underlying financial records.

Test frontend, backend, mobile, database, jobs, integrations and security boundaries.

Fix test failures before claiming completion.

---

# 35. DEVELOPMENT AND EXECUTION INSTRUCTIONS

You must act as the implementation agent, not merely as a consultant.

First:
1. Inspect the existing project folder, if any.
2. Inspect the attached logo and branding reference.
3. Identify available tools and environment.
4. Create the implementation architecture.
5. Establish database schema and migrations.
6. Set up the monorepo.
7. Implement backend foundations.
8. Implement authentication and permissions.
9. Implement tenant isolation.
10. Implement all business modules.
11. Implement web applications.
12. Implement Flutter application.
13. Implement background workers.
14. Implement automation engine.
15. Implement white-label capabilities.
16. Implement integration adapters.
17. Create tests.
18. Run tests.
19. Fix errors.
20. Build production artifacts.
21. Produce deployment documentation.

Continue working through all modules without asking for approval after each ordinary implementation step.

Only request user input for genuinely necessary external decisions, credentials, approvals, or irreversible actions.

Do not replace missing external services with fake production functionality.

Do not silently skip difficult modules.

Do not leave critical TODO placeholders or buttons that do nothing.

Use real database persistence for every operational feature.

Do not use static arrays as production data sources.

---

# 36. USER EXPERIENCE ACCEPTANCE RULES

The application must be understandable to non-technical typing centre staff.

For every screen:
- Use simple headings.
- Use familiar terminology.
- Keep navigation consistent.
- Avoid unnecessary fields.
- Explain what happens next.
- Show loading indicators.
- Show clear success and failure messages.
- Provide confirmation for destructive actions.
- Preserve user input on recoverable errors.
- Use searchable dropdowns for large lists.
- Support mobile and tablet screens.
- Ensure English and Arabic layouts work correctly.

A receptionist should be able to create a customer and start a request without technical training.

A customer should be able to request a service and track its progress without contacting staff for basic updates.

A centre owner should be able to understand daily operational performance from one dashboard.

---

# 37. DEPLOYMENT

Provide:
- Local development setup
- Docker Compose environment
- Production deployment configuration
- Database migration commands
- Seed commands
- Backend startup commands
- Frontend startup commands
- Flutter build commands
- Environment variable examples
- Reverse proxy configuration
- TLS setup guidance
- Object storage configuration
- Redis configuration
- Queue worker deployment
- Backup procedures
- Restore procedures
- Monitoring configuration
- CI/CD workflows

Do not commit secrets.

Use secure environment management.

Provide production readiness checks before deployment.

---

# 38. DOCUMENTATION

Generate:

README.md
ARCHITECTURE.md
DATABASE_SCHEMA.md
API_DOCUMENTATION.md
ROLE_PERMISSION_MATRIX.md
WORKFLOW_DOCUMENTATION.md
WHITE_LABEL_GUIDE.md
TENANT_ISOLATION.md
SECURITY_CHECKLIST.md
UAE_COMPLIANCE_REVIEW.md
DEPLOYMENT_GUIDE.md
CUSTOMER_USER_GUIDE.md
STAFF_USER_GUIDE.md
OWNER_USER_GUIDE.md
PLATFORM_ADMIN_GUIDE.md
TEST_REPORT.md
KNOWN_LIMITATIONS.md

Documentation must reflect actual implemented functionality.

---

# 39. FINAL DELIVERABLES

Provide:

1. Complete monorepo source code
2. Functional NestJS backend
3. PostgreSQL schema and migrations
4. Platform admin application
5. Typing centre management application
6. Customer web portal
7. Corporate portal
8. Flutter customer application
9. Automation engine
10. AI document processing adapter
11. Payment integration framework
12. Notification integration framework
13. White-label system
14. Subscription management
15. Reporting system
16. Docker configuration
17. Automated test suite
18. Documentation
19. Demo environment
20. Deployment instructions

If the environment supports file packaging, create a complete ZIP archive of the project.

Before finishing, execute all available lint, type-check, unit-test, integration-test, end-to-end-test and production-build commands.

Report:
- What was implemented
- What was tested
- Which tests passed
- Which tests failed
- Which external services require credentials
- Which government integrations require authorisation
- Which features remain blocked
- Whether the project is ready for production deployment

Never state that the project is fully production-ready if critical tests, security reviews, integrations or deployment checks remain incomplete.

---

# 40. FINAL INSTRUCTION

Build TypEase as a serious commercial software product.

The system must be:
- Simple for customers
- Easy for receptionists
- Efficient for typing operators
- Powerful for centre owners
- Secure for sensitive documents
- Scalable for multiple tenants
- Customisable for white-label customers
- Maintainable for future development
- Fully integrated across applications

Prioritise correctness, usability, privacy, security and complete business workflows over unnecessary visual complexity.

Use the supplied TypEase branding consistently throughout.

Do not stop at design, scaffolding or demonstration screens.

Implement, integrate, test, correct and document the complete product to the greatest extent supported by the available environment, and transparently report anything that cannot be completed or verified.

**START BUILDING TYPEASE NOW.**