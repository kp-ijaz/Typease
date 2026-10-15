# Staff guide

For the people who work at a typing centre: **receptionists**, **typing operators**, **document reviewers**
and **accountants**. Owners and managers: see the [owner guide](OWNER_USER_GUIDE.md) as well.

Menu names, buttons and messages are written exactly as they appear in the staff application in English.
The application is also available in Arabic. What you can see and do depends on your role; if a menu entry
or a button described here is missing, your role does not include it. The people, companies and numbers in
the examples are invented.

> **What TypEase does not do.** TypEase is not connected to any government portal or system. When an
> application is submitted to an authority, a member of staff does that outside TypEase, on the official
> portal with the centre's own authorised account, or through an authorised partner, and then records the
> reference in TypEase. **Never type a portal user name, password, PIN or one-time code into TypEase**, in any
> field. A status you record is shown to the customer as "Entered by staff (not verified by the authority)".

## Contents

1. [Signing in and your account](#1-signing-in-and-your-account)
2. [Who does what](#2-who-does-what)
3. [The life of a request](#3-the-life-of-a-request)
4. [Receptionist](#4-receptionist)
5. [Typing operator](#5-typing-operator)
6. [Document reviewer](#6-document-reviewer)
7. [Accountant](#7-accountant)
8. [For everybody](#8-for-everybody)
9. [When something is refused](#9-when-something-is-refused)

## 1. Signing in and your account

### How do I get an account?

The owner or a manager invites you. You receive an email with a link: open it, choose a password (at least
10 characters, with an upper-case letter, a lower-case letter and a number) and you are signed in. You
cannot register yourself.

### How do I sign in?

Open the staff application, enter your email address and password and choose **Sign in**. Staff do not
choose a centre: your account belongs to one. If it belongs to more than one, you are asked to **Choose a
centre**.

- **Forgot your password?** sends a reset link that is valid for one hour.
- Five wrong passwords lock the account for 15 minutes.
- Accountants, managers and owners must use **Two-step verification** when the centre's installation
  requires it. You are taken to **Set up two-step verification**: install an authenticator app, scan the
  code, enter the 6-digit code, and **save the recovery codes** (they are shown only once). Other roles can
  switch it on voluntarily.

### Where are my own settings?

Open the account menu (your name, top right):

- **My profile**: your name and the language of the messages sent to you.
- **Password and security**: change the password, two-step verification, and **Devices signed in**, where you
  can sign out a device you do not recognise.
- **Sign out**.

The **Branch** switcher at the top limits lists to one branch. You only see the branches you work at.
The bell shows messages addressed to you (**Notifications**).

![Dashboard of the staff application](../brand/screenshots/centre-dashboard-en-light-desktop.png)

## 2. Who does what

The four roles as they are built in. A centre can also create its own roles, so yours may differ.

| | Receptionist | Typing operator | Document reviewer | Accountant |
| --- | --- | --- | --- | --- |
| Sees requests | Of their branches | **Only those assigned to them** | Of their branches | Of their branches |
| Register and edit customers | Yes | View | View | View |
| Start a request | Yes | No | No | No |
| Upload documents | Yes | Yes | No | No |
| Check (verify) documents | No | Yes | Yes | No |
| Prepare the application | No | Yes | No | No |
| Record a submission and its result | No | Yes | No | No |
| Approve a review, complete a request | No | No | Yes | No |
| Prepare and send quotations | Yes | View | No | View |
| Create and issue invoices, credit notes | View | View | No | Yes |
| Record payments | Yes | No | No | Yes |
| Request a refund | No | Yes | No | Yes |
| Approve a refund | No | No | No | Yes |
| Expenses, fees owed to others, reconciliation | No | No | No | Yes |
| Appointments and queue | Yes | View appointments | No | No |
| Reports | No | No | No | Yes |
| See full identity numbers | No | No | No | No |
| Cancel or reopen a request, assign staff | No | No | No | No |

The last two rows are for managers and owners.

Menu entries by role:

| Role | Menu |
| --- | --- |
| Receptionist | Dashboard, Requests, Customers, Corporate clients, Documents, Appointments, Queue, Tasks, Reminders, Quotations, Invoices, Payments, Services, Support |
| Typing operator | Dashboard, Requests, Customers, Documents, Appointments, Tasks, Quotations, Invoices, Refunds, Services |
| Document reviewer | Dashboard, Requests, Customers, Documents, Tasks, Services |
| Accountant | Dashboard, Requests, Customers, Corporate clients, Quotations, Invoices, Payments, Refunds, Expenses & fees, Services, Reports, Scheduled reports |

## 3. The life of a request

Every request has a status. The application only offers the next steps that are allowed for your role, and
it says why a step is not possible yet.

| Status | What it means for you |
| --- | --- |
| Draft | Not submitted yet. Finish the form and the documents |
| New | Just submitted. Check the details and documents |
| Documents under review | Documents are being checked; the quotation is prepared |
| Awaiting customer | The centre asked the customer for something. Nothing moves until the customer answers |
| Quotation sent | The quotation is with the customer |
| Awaiting payment | Approved, invoiced, not paid yet |
| Ready for processing | An operator can start |
| In preparation | The operator is preparing the application |
| Pending review approval | Waiting for the reviewer |
| Ready to submit | The submission can be recorded |
| External processing | Submitted; waiting for the result |
| Returned | Came back for correction |
| Rejected | Not accepted. Decide with the customer how to continue |
| Final review | Last check before hand-over |
| Completed | Done |
| Cancelled | Stopped. Cannot be opened again |

Open a request from **Requests**. It has these tabs: **Overview**, **Details**, **Documents**, **Money**,
**Assignment and review**, **Submission**, **Messages**, **History**. The **Overview** shows **What happens
next**, who the request is waiting for, the current step of its workflow, and **What the customer sees now**.

![Overview of a request](../brand/screenshots/centre-cases-overview-en-light-desktop.png)

Some steps happen by themselves: when the customer approves the quotation the request moves to **Awaiting
payment**, and when the payment arrives it moves to **Ready for processing**. If you try to do such a step by
hand you see "This step happens automatically and cannot be done by hand."

## 4. Receptionist

### How do I register a customer?

**Customers** then **Add customer**. Only the name is required. Add a mobile number so that the customer can
receive updates.

- **Emirates ID number**: 15 digits starting with 784. It is stored encrypted and afterwards only the last
  four digits are shown.
- If the application says **This customer may already exist**, it found a record with the same Emirates ID,
  passport, mobile or email. Choose **Open existing record**, or **This is a different person, add anyway**.

![Adding a customer with the form checks](../brand/screenshots/centre-customers-add-validation-en-light-desktop.png)

### How do I find and read a customer record?

Search by name, mobile, email or customer number. The record has tabs for **Overview**, **Requests**,
**Documents**, **Invoices**, **Payments**, **Appointments**, **Messages sent**, **Expiry reminders**,
**Support** and **History**.

On the overview you can:

- **Edit** the profile. Identity numbers already on file are never shown in the form; leave the field empty
  to keep what is stored.
- add **Internal notes** (staff only; the customer never sees them), **Tags** and extra **Contacts**;
- **Invite to the portal**, so that the customer can follow requests and pay online. They receive an email
  with a link to choose a password;
- record a **Consent** decision the customer gave you in person or by phone (**Record a change**). It is
  stored as "Recorded by staff" with your name and the time. Tick **Offers and news from the centre** only
  when the customer agreed.

Full identity numbers (**Show full numbers**) are for managers and owners, and every use is recorded.

![A customer record](../brand/screenshots/centre-people-customer-overview-en-light-desktop.png)

### How do I start a request for a customer at the counter?

**New request**. Five steps: **Customer**, **Service**, **Details**, **Documents**, **Review and submit**.

1. **Customer.** Search and choose the customer. If the customer belongs to a company, you can tick **Bill
   this request to** the company.
2. **Service.** Search or choose a category. The panel shows the fees (the government and third-party
   amounts are estimates), the documents the customer needs and what the centre does for this service, for
   example "The centre prepares the documents. The customer submits the application themselves." Read that
   sentence to the customer. Choose the branch if needed, then **Save draft and continue**.
3. **Details.** Fill in the form. Fields with `*` are required. Values already known about the customer are
   filled in: check them.
4. **Documents.** Add what the customer brought. If a valid document is already on file you see **Already on
   file for this customer** and can choose **Use this document**. Missing documents can be added later, but
   the request cannot be processed without the required ones.
5. **Review and submit.** Check the summary with the customer and choose **Submit request**.

The request is kept as a draft from step 2. You can leave and continue later from the list of requests. The
customer and the service of a draft cannot be changed; start a new request instead.

After submitting you see the **Request number** and the **Tracking code**. **The code is shown only now.**
Choose **Print slip for the customer** or copy it: with the number and the code the customer can follow the
request online without an account.

![Request submitted, with the tracking code](../brand/screenshots/centre-cases-flow-wizard-submitted-en-light-desktop.png)

### How do I prepare and send a quotation?

1. Open the request, tab **Money**, **Create a quotation**. (Or **Quotations** then **New quotation**.)
2. The lines are built from the price of the service for the branch, or the company's contract price:
   service fee, government fee estimate, third-party charges. Correct the government and third-party amounts
   to what actually applies. You can set **Valid until** and **Notes for the customer**.
3. A **Discount on the service fee** needs a **Reason for the discount** and has to be approved by a second
   person (an owner or manager) before the quotation can be sent. Discounts are not possible on government
   fees or third-party charges.
4. On the quotation page choose **Send to customer**. A quotation that was sent cannot be changed; cancel it
   and create a new one if the price changes.

If the customer answers at the counter or by phone, choose **Record customer's decision**, then **The
customer approves** or **The customer declines**, and write how they told you. It is recorded that you
entered it on their behalf. On approval the invoice is issued automatically.

### How do I take a payment?

**Payments** then **Record payment** (or **Record a payment** on the request's **Money** tab).

1. **Who paid?** A customer or a company account.
2. Method: **Cash**, **Card terminal**, **Bank transfer** or **Cheque**; the **Amount received**; a reference
   (voucher number, terminal slip, transfer reference or cheque number); the branch.
3. **Which invoices does it pay?** Enter the amount per invoice, or use **Oldest first**. The amounts must add
   up to what you received, and no invoice can be paid beyond its balance.
4. **Record payment**. The receipt is ready to print.

Important:

- **A recorded payment cannot be edited or deleted.** If it was wrong, a refund has to be requested.
- Never write a card number in the reference or the note. The application refuses anything that looks like
  one.
- If the page says **This payment may already be recorded**, check **Payments** before trying again.

To let a customer pay by card online, open the invoice and choose **Create payment link**. This needs an
online payment provider set up by the owner; otherwise you see **Online payments are not set up**. A link the
customer opens but does not complete is closed by the system after 60 minutes; nothing is charged, and a new
link can be created.

![Recording a payment](../brand/screenshots/centre-fin-payment-new-en-light-desktop.png)

### How do I book an appointment?

**Appointments** then **Book appointment**. Choose the branch and the day, **A customer on file** or **A guest
(name and phone)**, the service, and one of the **Free times**. If no times are offered, booking hours are
not set for that day (a manager sets them under **Calendar settings**).

When the person arrives, open the appointment and choose **Check in**. They get a **queue token**. Other
actions: **Confirm**, **Reschedule**, **Cancel appointment**, **Mark as no-show** (only after the start time).
The agenda shows how many earlier appointments a customer missed.

![Week view of appointments](../brand/screenshots/centre-ops-appointments-week-en-light-desktop.png)

### How do I run the walk-in queue?

**Queue**, tab **Counter**.

- **Issue token**: choose the service category (and the customer, if known). The token number looks like
  `A-014`.
- Enter **Your counter** number once, then **Call next**. You see "A-014, please come to counter 3."
- **Start serving**, then **Done**. If nobody comes: **Call again**, then **No-show**.
- **Waiting times** shows how long people waited.
- **Display screen**: **Create display link** for the screen in the waiting area. It shows token numbers and
  counters only, never names, phone numbers or services. Copy the link at once; it is shown only then.

![The queue counter](../brand/screenshots/centre-ops-queue-en-light-desktop.png)

### How do I answer a customer's question about a request?

Open the request, tab **Messages**. Switch **Visible to the customer** on to **Write to the customer**; they
can read it in the portal and are notified. The customer sees your first name only, never your full name.
With the switch off it is an **Internal note** that only staff see. Check the switch before you send.

You can read tickets under **Support**. Replying to tickets and resolving them is for managers and owners.

## 5. Typing operator

### Where is my work?

- **Requests** lists only the requests assigned to you. If a request "is not available", it is not assigned
  to you; ask your manager.
- **Tasks**: **My tasks** are yours. **Waiting for my role** lists tasks nobody has taken yet: choose **Take
  this task**. A task marked **Completes automatically** belongs to a step of a request: open the request and
  do the step there. You cannot mark it done by hand.

![Tasks of an operator](../brand/screenshots/centre-cases-tasks-en-light-desktop.png)

### How do I check a document?

Open the request, tab **Documents**. Each line of **Documents from the customer** shows whether it is
required and what was uploaded. Choose **Check document**:

| Result | When |
| --- | --- |
| **Accept** | Readable, complete and the right document |
| **Ask for a better copy** | The right document, but unreadable, cut off or incomplete |
| **Reject** | The wrong document, expired or not acceptable |

- For the last two, write **What has to be corrected?** The customer reads this, so say what to bring.
- Enter the **Expiry date on the document** only if you compared it with the document. It is then stored as
  confirmed, and an expiry reminder can follow from it.
- A file that shows **Security check running** cannot be opened yet. **Blocked** means the security check
  refused the file: ask for a new copy.
- **Not needed for this request** marks a line as provided, with a reason. **Add a document line** adds a
  document this request needs in addition to the standard list.

![Document checklist of a request](../brand/screenshots/centre-cases-documents-en-light-desktop.png)

### How do I ask the customer for something?

Choose **Request information**. Write the **Message to the customer** (say exactly what is needed), tick the
checklist lines that need a new file, and add lines for further documents if necessary. **Send to the
customer**. The request waits; nothing moves until the customer answers. When they have, the request returns
to where the question was asked. If the customer answered by phone or at the counter, choose **Continue the
request** yourself.

### Can the application read a document for me?

If the centre has switched on the AI document assistant, **AI reading (unverified)** on a document offers
**Read the document**. It suggests values such as the number, the name and the expiry date.

- The values are **not verified**. Nothing is saved to the customer file until a person has compared every
  value with the document.
- Operators can start a reading. **A reviewer has to confirm the values** and apply them (section 6).
- If you see "The customer has withdrawn consent for automatic reading of their documents", enter the
  details by hand.
- Only passports, Emirates IDs and trade licences are supported, and the reading can be wrong.

### How do I prepare an application?

1. The request must be **Ready for processing** and assigned to you. Choose **Start preparation**.
2. Work on the application. Use **Details** then **Edit details** to correct the form, and **Messages** for
   notes to colleagues.
3. When you are done, choose **Mark preparation as done**. The workflow decides what follows: review,
   submission or the final check. You may also see **Send for review**, **Mark ready to submit** or **Send to
   final review** directly.

If the service requires a review, **Mark ready to submit** is refused with "This case needs the approval of a
reviewer first." You cannot review your own work.

### How do I record a submission?

Tab **Submission**. First read what the page says about the service:

| The page says | Meaning |
| --- | --- |
| The customer submits the application themselves | Nothing can be recorded as submitted by the centre. Hand over the prepared documents |
| The centre coordinates the submission with an authorised partner | Record the partner and the reference they give you |
| Authorised staff submit on the official portal with the credentials of the centre | Submit on the official portal yourself, then record the reference here |

To record: **Record a submission**, choose **How was it submitted?** (only the channels the service permits
are offered), enter the **Reference number** exactly as shown on the receipt or the portal, the **Authority**
and, for a partner, the **Partner** name. **Record submission**. The request moves to **External
processing**.

Afterwards:

- **Update the status** with what the authority or partner reported to you. The customer sees it with its
  source label.
- **Record the result** when there is a final answer: **Approved or completed** (the request goes to the
  final check), **Returned for correction** (it comes back to you) or **Rejected**. Write what was reported.

**Official integration** as a channel is not available: no such connection exists.

![Submission tab of a request](../brand/screenshots/centre-cases-external-en-light-desktop.png)

### How do I attach the finished documents?

Tab **Documents**, section **Completed documents**: **Attach** the file to its line, or **Add a completed
document** to add a line. Required completed documents must be attached before the request can be completed.

### How do I ask for a refund?

**Refunds** then **Request refund**. Choose the payment, the invoice, the amount and the reason, and say
**What happens to the charge?**

- **The charge is cancelled**: the customer gets the money back and no longer owes it. Use it when the
  service was not delivered, was cancelled or cost less than charged.
- **The charge stays**: only the money goes back and the invoice becomes unpaid again. Use it when the
  payment itself was wrong (paid twice, wrong customer).

Nothing is paid out until another person approves it.

## 6. Document reviewer

### How do I check documents and AI readings?

Check documents as described in section 5. For an AI reading, open the document's **AI assistant** tab (or
**AI reading** on the request). The table shows what was **Read by the assistant** next to what is **On the
customer file**. In the last column type **what you read on the document**, or choose **Cannot be read: leave
out**. **Save my review** records your reading and changes nothing on the customer file. Then, under **Apply
to the customer file**, tick the reviewed values to copy and choose **Apply the chosen values**.

A high confidence is strong evidence, not proof. Compare every value with the document.

### How do I decide on a review?

Requests waiting for you are **Pending review approval**, and you have a task for each. Open the request,
tab **Assignment and review**, **Decide on this review**:

- **Approve**: the application is correct and may be submitted.
- **Send back**: write **What has to be corrected?** Only staff see this. The request returns to the
  operator, and a later approval is needed again.

If you are the operator of the request you see **You cannot review your own work**. Another reviewer has to
decide.

### How do I complete a request?

In **Final review**, check the completed documents against the request and choose **Complete**. The customer
is told that the documents are ready.

The application refuses to complete a request when:

- a required completed document is missing ("The completed documents are missing. Attach them under
  Documents.");
- an invoice of the request still has a balance;
- a required review was not approved.

If something is wrong, choose **Send back** with a reason.

## 7. Accountant

### How do I create and issue an invoice?

Most invoices are created automatically when a customer approves a quotation. For anything else:

1. **Invoices** then **New invoice**. Choose who it is for, and optionally the request. Tick **Invoice the
   customer's company account** to bill a company.
2. Add lines and say what kind of charge each one is: **Service fee line**, **Government fee line** or
   **Third-party charge line**. Government fees and third-party charges are collected on behalf of others:
   they are shown separately, cannot be discounted and are never counted as the centre's revenue.
3. **Save draft**, check the totals on the next page, then **Issue invoice**. The invoice gets its number at
   that moment, and its **Due** date: the end of the day of issue plus the centre's "days until invoices are
   due" setting, or the company's payment terms for an invoice on approved credit. An invoice with a balance
   past that date is **Overdue** (filter **Overdue only**; the invoice page says "This invoice was due on ...
   and is not fully paid").

**An issued invoice cannot be changed.** To correct it:

- **Issue credit note** reduces what the customer still owes. It cannot be more than the open balance.
- Money that was already paid is returned with a refund, not with a credit note.
- **Void invoice** is possible only while nothing was paid or credited.

A discount on an invoice that does not come from an approved quotation has to be confirmed at issue by
somebody who may approve discounts and did not create the draft.

For a company with approved credit the invoice page shows the **Open balance of the company**, the **Credit
still available** and the **Payment terms**; issuing is refused when the credit limit would be exceeded.
**Open the company statement** shows what is due and how old it is.

![An issued invoice](../brand/screenshots/centre-fin-invoice-detail-en-light-desktop.png)

### How do I record a payment?

As in section 4. Online payments appear by themselves under **Payments** with the method **Online payment**
once the provider has confirmed them; until then they are **Pending**.

### How do I handle a refund request?

**Refunds** shows how many requests are waiting. You can approve or reject requests made by other people,
never your own.

1. Open the refund. Check the reason, the payment and **What happens to the charge?** You may change that
   choice if it is not right.
2. **Approve refund** or **Reject** (with a reason).
3. For a payment taken online the money is sent back through the payment provider. If the provider cannot do
   it, you see **The payment provider could not refund it**: **Send to the provider again** or **Complete by
   hand**.
4. For cash, card terminal, bank transfer and cheque: hand the money back, then **Record pay-out** with its
   reference.

When the charge was cancelled a credit note is issued automatically. The government and third-party parts of
a refund reduce what the centre holds for others; they are not a loss of revenue.

![Approving a refund](../brand/screenshots/centre-fin-refund-approval-en-light-desktop.png)

### What are "Expenses & fees"?

Four tools under one menu entry:

| Tab | Use |
| --- | --- |
| **Expenses** | What the centre paid out: government fees passed on to the authority, third-party payments, rent, salaries, supplies, utilities, other |
| **Fees owed to others** | Government fees and third-party charges collected from customers and not yet passed on. This money is not the centre's revenue |
| **Reconciliation** | Compare the payments recorded in TypEase with a bank, terminal or gateway statement |
| **Fee settings** | How each part of a price is named and treated. Accountants can read these; the owner changes them |

**Passing on a government fee.** When the centre has paid a fee to an authority for a request, add an
expense with the category **Government fees passed on** and choose the request. The page shows what was
collected for this request and not yet passed on; **Use this amount**. The request's fees are then marked as
passed on. You cannot record more than was collected. TypEase does not pay any authority: the expense records
a payment the centre made itself.

![Fees owed to others](../brand/screenshots/centre-fin-liabilities-ar-dark-desktop.png)

**Reconciling.** **New reconciliation**: choose the payment method and the statement period, enter what the
statement says was **Settled** and any **Bank or gateway fees**, and attach the payments the statement covers
(**Attach all**, or select). The page shows the **Difference**. Close it when it matches, or with a note
explaining the difference. A closed reconciliation cannot be changed.

![A reconciliation](../brand/screenshots/centre-fin-reconciliation-detail-en-light-desktop.png)

### Which reports are there?

**Reports** lists what your role may see.

| Financial | Operations and customers |
| --- | --- |
| Daily sales | Requests by status |
| Monthly service revenue | Staff workload and performance |
| Transactions by service | Branch performance |
| Outstanding payments | Customer growth |
| Refunds | Expiry reminders |
| Government-fee and third-party liabilities | Document processing time |
| Corporate revenue | Customer satisfaction |
| Service profitability | |

Open a report, choose the period and the branch, and read **How these figures are calculated** below the
table. **Export** gives an Excel, PDF or CSV file. **Send by email on a schedule** creates a scheduled report
(daily, weekly or monthly) that goes to staff who are allowed to see that report; it needs the plan feature
"Scheduled reports".

Revenue in the reports is the centre's service fees. Government and third-party fees are shown separately.
The exports and all PDF documents are in English.

![Daily sales report](../brand/screenshots/centre-fin-report-daily-sales-en-light-desktop.png)

## 8. For everybody

### What do the customers see?

- The customer wording of a status, shown on the request's overview under **What the customer sees now**.
  "In preparation" and "Pending review approval" both read "Being prepared" for the customer.
- Messages you marked **Visible to the customer** (signed with your first name only), the reasons you wrote
  when rejecting a document, and the message you wrote when requesting information.
- Documents that are **Visible to the customer** (staff uploads are, unless switched off).
- Never: internal notes, the reason for a status change, who is assigned, or internal tasks.

### How do I print something for the customer?

- Request: **Print a summary** on the overview; the slip with the tracking code right after submitting.
- Quotation, invoice, receipt, credit note: **Download PDF** or **Print**.

PDF documents are in English only, and Arabic text in names or footers is not printed correctly. Tell
customers who need an Arabic document that this is not available.

### How do documents stay safe?

Files open through a link that works for about two minutes, and every view, download and share is recorded in
the document's **Access log**. Do not forward downloaded files by email or chat. If a document must be sent
to somebody outside, a manager can create an expiring share link.

### What if I work at more than one branch?

Use the **Branch** switcher. You never see requests, appointments or queues of a branch you do not work at.

## 9. When something is refused

The application explains a refusal in plain words. The most common ones:

| Message | What to do |
| --- | --- |
| The request cannot move to that status from where it is now. Reload the page: someone may have changed it | Reload |
| Every required document has to be checked first | Verify or reject each required document |
| A rejected document has not been replaced yet | Upload a new file, remove it from the line, or mark the line as not needed |
| The payment for this request has not been received yet | Record the payment, or wait for the online payment |
| Nobody is assigned yet. Assign an operator first | Ask a manager to assign the request |
| This case needs the approval of a reviewer first | Send it for review |
| The person who prepared a case cannot also review it | Another reviewer has to decide |
| The centre does not submit applications for this service | The customer submits; hand over the prepared documents |
| This submission channel is not allowed for this service | Choose a channel the page offers |
| Record the result of the submission first | Use **Record the result** on the Submission tab |
| An invoice of this request still has a balance | The request can be completed when it is paid |
| This task completes automatically when the request moves on | Open the request and do the step there |
| You do not work at this branch | Ask a manager |
| Your current plan does not allow this | Ask the centre owner |

If a message appears in English while you work in Arabic: some messages from the system exist in English
only.
