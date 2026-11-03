// STA-47: one corpus of exact questions (count, status, completeness) that a
// context bundle must refuse, and of ordinary retrieval requests it must
// serve, shared by the unit test of `exactQuestion` and the service test of
// `PostgresContextBundles`. It holds every sibling local review raised, and
// new variants of each structure the classifier recognizes.

/** [text, kind]: requests only exact authoritative reads can answer. */
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
  ['Has every ticket been closed?', 'status'], ["I'm wondering whether it shipped", 'status'], ['what do we owe the vendor', 'count']]);

/** Ordinary retrieval requests, which a bundle serves. */
export const ordinaryRequests = Object.freeze(['harbor lantern', 'Why was the lantern lit at dusk?', 'account recovery notes',
  'everything about tides', 'discounted fares', 'the keeper described the tower', 'Draft a summary of the lantern keeper notes',
  'overdue invoice', 'Summarize the bridge repair discussion', 'What did the keeper write about the storm?', 'invoice amount dispute',
  'Which keeper lit the lantern?', 'notes on the open sea crossing', 'Why was the gate left open?', 'tell me about the lantern keeper',
  'what the harbor master said about tides', 'a shopping list for the lighthouse', 'it was all about the tides', 'kestrel nest',
  'tidal gauge', 'Describe the storm damage to the tower', 'Explain why the lantern failed', 'Find notes about the harbor lantern',
  'Who reviewed the lantern claim?', 'Can you summarize the keeper log?', 'Please describe the tower', 'Show me notes about the storm',
  'Tell me what the keeper wrote about tides', 'What happened during the storm?', 'Who signed the harbor treaty?',
  'Why did the vendor raise prices?', 'How does the lantern mechanism work?', 'explain the invoice dispute with the vendor',
  'find the keeper notes on fog signals', 'summarize what the harbor master wrote', 'who wrote the storm log',
  'Describe how the bridge was repaired', 'hands-on lantern maintenance notes', 'weather at the harbor in March']);
