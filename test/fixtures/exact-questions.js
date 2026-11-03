// STA-47: one corpus of bundle requests, shared by the unit test of
// `exactQuestion` and the service test of `PostgresContextBundles`, in three
// tables: requests a bundle must refuse (every sibling local review raised,
// and new variants of each structure), ordinary requests in the allowed forms
// it must serve, and documented over-refusals with a served rephrasing.

/**
 * [text, kind]: requests a bundle refuses. The kind is the deny rule's
 * (`count`, `status`, `completeness`), or `unrecognized` for a question or
 * instruction outside the allowed forms.
 */
export const exactQuestions = Object.freeze([
  // Count: how many or how much, counts, totals, quantities and amounts.
  ['How many invoices are overdue?', 'count'], ['count the open tickets', 'count'], ['Count the overdue invoices', 'count'],
  ['number of lanterns in the harbor', 'count'], ['What is the TOTAL spend?', 'count'], ['\uff48\uff4f\uff57 \uff4d\uff41\uff4e\uff59 keepers', 'count'],
  ['What is the quantity of invoices?', 'count'], ['how much do we owe', 'count'], ['the amount of rope ordered', 'count'],
  ['How often did the lantern fail', 'count'], ['how-many invoices', 'count'], ['how_many invoices', 'count'],
  ['how.many invoices', 'count'], ['how\u200bmany invoices', 'count'], ['c\u00adount the invoices', 'count'],
  ['how\u00a0\u00a0many keepers', 'count'], ['how\nmany keepers', 'count'], ['Tell me the tally of votes', 'count'],

  // Status by name: status, state, stage, progress.
  ['status of the bridge repair', 'status'], ['status of invoice two', 'status'], ['sta\u200dtus of the repair', 'status'],
  ['What is the current state of the migration?', 'status'], ['give me the overall progress', 'status'],
  ['how far along is the bridge repair', 'status'], ['What state is invoice two in?', 'status'],
  ['Which stage is the audit at?', 'status'], ['pro\u{e0020}gress of the audit', 'status'],

  // Any yes/no question: a clause opening with an auxiliary or a modal, after any request prefix.
  ['Is the bridge repair done?', 'status'], ['Has the claim been approved', 'status'], ['Is invoice two paid?', 'status'],
  ['Is invoice two paid or still open?', 'status'], ['Please, is invoice two paid?', 'status'], ["Isn\u2019t the ticket resolved?", 'status'],
  ['Lantern review: was it approved', 'status'], ['Has the shipment arrived?', 'status'], ['Did the vendor pay?', 'status'],
  ['Did we finish the audit?', 'status'], ['Is the bridge repaired?', 'status'], ['is anything missing', 'status'],
  ['Does invoice two remain outstanding', 'status'], ['Were the keepers relieved on schedule?', 'status'],
  ["Hasn't the vendor sent the parts", 'status'], ['Do the towers have power again?', 'status'], ['am I cleared to sail', 'status'],
  ['Will the shipment arrive on Friday?', 'status'], ["Won't the audit close this week?", 'status'],
  ['Could you tell me, did the keeper sign?', 'status'], ['Hey, so did the vendor ever deliver?', 'status'],
  ['Invoice two: has it cleared?', 'status'], ['is\u2060 the invoice p\u200caid', 'status'], ['is.the.invoice.paid', 'status'],
  ['Can you check: is the gate fixed?', 'status'], ['I want to know, was the lantern relit?', 'status'],

  // Embedded whether- and if-questions.
  ['Please tell me whether the bridge repair is done', 'status'], ['Can you check if the invoices are unpaid', 'status'],
  ['let me know whether the vendor shipped the parts', 'status'], ['I wonder if the harbor master signed off', 'status'],
  ['find out whether the keeper relieved the watch', 'status'], ['tell me if the tower lamp works', 'status'],

  // A state still or not yet reached.
  ['tickets still open', 'status'], ['invoices not yet paid', 'status'], ['invoices not yet reconciled', 'status'],
  ['are the repairs done yet', 'status'],

  // Which, what or whose things are, have been or got into a state; who has been or is in one.
  ['which tickets remain unresolved', 'status'], ['What is still pending on the bridge?', 'status'],
  ['Which invoices have been paid?', 'status'], ["Tell me which invoices haven't been paid", 'status'], ['What has shipped?', 'status'],
  ['Which claims got approved?', 'status'], ['Which tickets are currently open?', 'status'],
  ['Which orders have been dispatched?', 'status'], ["What's been reconciled so far?", 'status'],
  ['Which of the invoices the vendor sent in March were never settled?', 'status'], ['Whose claims got rejected', 'status'],
  ['show me which repairs are now complete', 'status'], ['what got done on the bridge', 'status'],
  ['Who has been paid?', 'status'], ['who is still missing from the roster', 'status'], ['which tickets closed this week', 'status'],
  ['what shipped yesterday', 'status'], ['Which lanterns are lit?', 'status'],

  // Existence and whether more exists.
  ['Are there any other keepers?', 'completeness'], ['Is there anything else about the lantern?', 'completeness'],
  ['Is there more?', 'completeness'], ['which towers exist', 'completeness'], ['Does a log for the storm exist', 'completeness'],
  ['any more invoices from the vendor', 'completeness'], ['what else did the keeper record', 'completeness'],
  ['the rest of the suppliers', 'completeness'], ['Are there notes on the storm?', 'completeness'],

  // Every member of a set, enumeration, and what remains.
  ['list all suppliers', 'completeness'], ['list all overdue invoices', 'completeness'], ['Show all suppliers', 'completeness'],
  ['all invoices from March', 'completeness'], ['every decision about the harbor', 'completeness'],
  ['Give me the complete list of towers', 'completeness'], ['List the suppliers', 'completeness'],
  ['please enumerate the towers', 'completeness'], ['Can you list the suppliers?', 'completeness'],
  ['Give me a list of suppliers', 'completeness'], ['Name each supplier', 'completeness'], ['name all the keepers', 'completeness'],
  ['list\ufeff all suppliers', 'completeness'], ['list_all suppliers', 'completeness'], ['each supplier we used', 'completeness'],
  ['could you please itemize the repairs', 'completeness'], ['what is left to do on the bridge', 'status'],
  ['who remains on the roster', 'completeness'], ['nothing missing from the log?', 'completeness'],
  ['which suppliers remain', 'completeness'], ['what is missing from the ledger', 'status'],
  ['What remains to be done?', 'status'],

  // Requests for the things in a state, or to confirm one; a state asked by a question mark alone; progress idioms.
  ['Show me the unpaid invoices', 'status'], ['Give me the open tickets', 'status'], ['find open tickets', 'status'],
  ['Confirm the invoice was paid', 'status'], ['check that the audit has finished', 'status'], ['invoice two paid?', 'status'],
  ['the shipment arrived?', 'status'], ['the invoice, paid or not', 'status'], ['How is the bridge repair going?', 'status'],
  ['where do we stand on the audit', 'status'], ['any update on the shipment', 'status'], ['When will the parts arrive', 'status'],
  ['which invoices are yet to be paid', 'status'], ['who hasn\'t paid', 'status'], ['Tell me the invoices that have been paid', 'status'],
  ['Could you let me know if invoice two has been paid?', 'status'], ["I'd like to know which invoices are outstanding", 'status'],
  ['Has every ticket been closed?', 'status'], ["I'm wondering whether it shipped", 'status'], ['what do we owe the vendor', 'count'],

  // Round 3: ordinary phrasings outside the deny rules, refused because a bundle serves only the allowed forms (fail closed).
  ['Which invoices carry an unpaid balance?', 'unrecognized'], ['Show me invoices marked unpaid', 'status'],
  ['What is the size of the invoice collection?', 'count'], ['Provide the complete supplier list.', 'completeness'],
  ['Which invoices did the vendor pay?', 'unrecognized'], ['What did we finish?', 'unrecognized'], ['Which keepers are on duty?', 'status'],
  ['Which claims are under review?', 'status'], ['Which invoices are awaiting payment?', 'status'],
  ['Which accounts are overdrawn?', 'unrecognized'], ['Which shipments went out?', 'unrecognized'],
  ['Which supplier went bankrupt?', 'unrecognized'], ['Which vendors failed to deliver?', 'unrecognized'], ['What broke?', 'unrecognized'],
  ['What are the suppliers?', 'unrecognized'], ['Who are our suppliers?', 'unrecognized'], ['What suppliers do we have?', 'unrecognized'],
  ['Which suppliers do we use?', 'unrecognized'], ['Show me the suppliers', 'unrecognized'], ['Give me the suppliers', 'unrecognized'],
  ['Show the suppliers', 'unrecognized'], ['Give me a listing of suppliers', 'completeness'], ['What is the sum?', 'count'],

  // New variants: wh- and do-support questions with unlisted verbs, instructions with unlisted verbs, requests to be given a set.
  ['Which lighthouse keepers transferred?', 'status'], ['What did the council approve?', 'unrecognized'],
  ['What tickets did Ana triage?', 'unrecognized'], ['Who handles the harbor permits?', 'unrecognized'],
  ['Whose invoices bounced?', 'unrecognized'], ['Where is the storm log?', 'unrecognized'], ['When did the shipment leave?', 'unrecognized'],
  ['Furnish the suppliers', 'unrecognized'], ['Rattle off suppliers', 'unrecognized'], ['Compile supplier names', 'unrecognized'],
  ['Quantify the backlog', 'unrecognized'], ['Get me everyone on the roster', 'completeness'], ['Pull up suppliers', 'unrecognized'],
  ['I need the suppliers', 'unrecognized'], ['Do you have the supplier names?', 'unrecognized'], ['Can I see the suppliers?', 'unrecognized'],
  ["I'd like the vendors", 'unrecognized'], ['I want to check the suppliers', 'unrecognized'], ['Tell me the suppliers', 'unrecognized'],
  ['Find me the vendors', 'unrecognized'], ['the vendors?', 'unrecognized'], ['give_me_the_suppliers', 'unrecognized'],
  ['What happened to the shipment?', 'unrecognized'], ['tell me, who are the vendors', 'unrecognized'],
  ['What about the vendors?', 'unrecognized'], ['Walk me through the suppliers', 'unrecognized'],
  ['Fill me in on the suppliers', 'unrecognized'], ['Present the suppliers', 'unrecognized'],
  // An allowed form whose content asks an exact question is still refused by the deny rules.
  ['Summarize which invoices were paid', 'status'], ['Explain whether the vendor paid', 'status'],
  ['Find notes about which keepers are on duty', 'status'], ['Summarize the unpaid invoices', 'status'],
  ['What did the keeper say about who was paid', 'status'], ['Describe every supplier', 'completeness'],
  ['Why did the vendor raise prices, and how many invoices are late?', 'count']]);

/** Ordinary retrieval requests, which a bundle serves. */
export const ordinaryRequests = Object.freeze(['harbor lantern', 'Why was the lantern lit at dusk?', 'account recovery notes',
  'everything about tides', 'discounted fares', 'the keeper described the tower', 'Draft a summary of the lantern keeper notes',
  'overdue invoice', 'Summarize the bridge repair discussion', 'What did the keeper write about the storm?', 'invoice amount dispute',
  'notes on the open sea crossing', 'Why was the gate left open?', 'tell me about the lantern keeper',
  'what the harbor master said about tides', 'a shopping list for the lighthouse', 'it was all about the tides', 'kestrel nest',
  'tidal gauge', 'Describe the storm damage to the tower', 'Explain why the lantern failed', 'Find notes about the harbor lantern',
  'Who reviewed the lantern claim?', 'Can you summarize the keeper log?', 'Please describe the tower', 'Show me notes about the storm',
  'Tell me what the keeper wrote about tides', 'What happened during the storm?',
  'Why did the vendor raise prices?', 'How does the lantern mechanism work?', 'explain the invoice dispute with the vendor',
  'find the keeper notes on fog signals', 'summarize what the harbor master wrote', 'who wrote the storm log',
  'Describe how the bridge was repaired', 'hands-on lantern maintenance notes', 'weather at the harbor in March',
  'Give me a summary of the storm', 'Can I see notes about the storm?', 'I need background on the harbor treaty',
  'Compare the keeper logs from March and April', 'Outline the lantern maintenance procedure', 'How did the storm damage happen?',
  'What was said about the tides?', 'notes on what happened during the storm', 'I want to know about the lantern',
  'Do you have notes about fog signals?', 'Explain how the lantern works', 'Give me an overview of the harbor treaty',
  'Find records about the bridge repair', 'Show me information on fog signals', 'lantern lighting by the keeper', 'map of the harbor',
  'What did the harbor master write about the treaty?', 'Search for notes about the storm', 'Fetch the context on the vendor dispute',
  'report on the storm', 'Please find excerpts about tides, and explain why the gauge drifted']);

/**
 * [text, rephrasing]: requests that ask no exact question but are refused
 * because their form is not an allowed one, each with a rephrasing a bundle
 * serves. Failing closed costs these; failing open would cost AC3.
 */
export const overRefusals = Object.freeze([
  ['Which keeper lit the lantern?', 'notes about the keeper lighting the lantern'],
  ['Who signed the harbor treaty?', 'Describe the signing of the harbor treaty'],
  ['How was the bridge repaired?', 'Describe how the bridge was repaired'],
  ['What is a tidal gauge?', 'Explain tidal gauges'],
  ['What was decided about tides?', 'Summarize the decision about tides'],
  ['Does the keeper log describe the storm?', 'Find notes about the storm in the keeper log'],
  ['notes the keeper wrote', 'notes written by the keeper'],
  ['the keeper who lit the lantern', 'the keeper lighting the lantern'],
  ['procedures if the lantern fails', 'procedures for a lantern failure'],
  ['follow-up notes on the storm', 'notes on the storm follow-up'],
  ['open questions about tides', 'Summarize the questions about tides'],
  ['harbor lantern?', 'harbor lantern']]);
