// A generic relevance corpus for retrieval evaluation (STA-49): ordinary notes, documents and attributed claims on
// everyday topics, in three collections, with graded judgments. It measures how the lexical list, the vector list
// and their fusion rank what a query is about; it is not tuned to any customer domain, and its numbers describe this
// corpus and the embedder used, never a guarantee for other content.
//
// Each document is `{ id, collection, kind, text }`; a record stores `text` in its `note` field. Each query is
// `{ id, query, class, relevant: { documentId: grade } }` (grade 2: about exactly what is asked; 1: on topic), with an
// optional `filter` of `collections` and `kinds`, which judges only the documents inside it.
//
// Query classes:
// - `keyword`: shares its main words with the relevant documents.
// - `morphology`: the same words in another inflection (`repairing` for `repair`), which stemming joins.
// - `paraphrase`: shares no content word with the relevant documents, so only a semantic embedder can find them.
// - `filtered`: a keyword query restricted by collection or kind, measuring filter recall.

export const relevanceCollections = Object.freeze(['notes', 'library', 'claims']);

const d = (id, collection, kind, text) => ({ id, collection, kind, text });
export const relevanceDocuments = Object.freeze([
  d('light-1', 'notes', 'record', 'The lighthouse lens was cleaned and polished before the winter storms.'),
  d('light-2', 'library', 'source', 'Lighthouse keepers trim the lamp wick nightly and clean the Fresnel lens weekly so the beam stays bright.'),
  d('light-3', 'claims', 'claim', 'The lighthouse beam is visible for twenty nautical miles in clear weather.'),
  d('tide-1', 'notes', 'record', 'The tide gauge at the harbor recorded an unusually high water level during the spring tide.'),
  d('tide-2', 'library', 'source', 'A tide gauge measures sea level against a fixed benchmark; readings are logged every six minutes.'),
  d('bread-1', 'notes', 'record', 'Sourdough bread needs a long cold fermentation for an open crumb.'),
  d('bread-2', 'library', 'source', 'Bakers feed the sourdough starter with flour and water and bake the loaf in a hot covered pot.'),
  d('bread-3', 'claims', 'claim', 'Rye flour makes a denser loaf than wheat flour.'),
  d('bike-1', 'notes', 'record', 'Bicycle repair: replaced the worn chain and adjusted the rear derailleur.'),
  d('bike-2', 'library', 'source', 'To repair a punctured bicycle tube, find the hole, roughen the rubber, apply a patch and reinflate.'),
  d('bike-3', 'claims', 'claim', 'A chain checker shows when a bicycle chain has stretched and must be replaced.'),
  d('bee-1', 'notes', 'record', 'Inspected the beehive frames; the queen was laying and the colony had stored honey.'),
  d('bee-2', 'library', 'source', 'Worker bees collect nectar from flowers, reduce its water by fanning their wings, and seal it in wax cells.'),
  d('bee-3', 'claims', 'claim', 'Beekeepers leave enough honey in the hive for the colony to survive the winter.'),
  d('solar-1', 'notes', 'record', 'The rooftop solar panels produced less power after the dust storm until they were washed.'),
  d('solar-2', 'library', 'source', 'Photovoltaic modules convert sunlight into electricity; output falls as the cells heat up.'),
  d('flood-1', 'notes', 'record', 'The river flooded the lower meadow after three days of heavy rain.'),
  d('flood-2', 'library', 'source', 'Floodplains absorb excess river water, and levees protect towns from rising water.'),
  d('flood-3', 'claims', 'claim', 'The river crested two meters above its normal level during the flood.'),
  d('bird-1', 'notes', 'record', 'Swallows gathered on the wires before their autumn migration south.'),
  d('bird-2', 'library', 'source', 'Migratory birds navigate using the sun, the stars and the earth magnetic field on their long journeys.'),
  d('glacier-1', 'library', 'source', 'The glacier has retreated four hundred meters since the first survey, leaving bare moraine.'),
  d('glacier-2', 'claims', 'claim', 'The glacier lost a fifth of its ice volume over three decades.'),
  d('compost-1', 'notes', 'record', 'Turned the compost heap; added dry leaves to balance the kitchen scraps.'),
  d('compost-2', 'library', 'source', 'Compost needs a mix of green nitrogen material and brown carbon material, air and moisture to decompose.'),
  d('scope-1', 'notes', 'record', 'Collimated the telescope mirrors so the stars focus to sharp points.'),
  d('scope-2', 'library', 'source', 'A reflecting telescope gathers starlight with a curved primary mirror and a smaller secondary mirror.'),
  d('wool-1', 'notes', 'record', 'Dyed the wool skeins with onion skins for a golden yellow colour.'),
  d('wool-2', 'claims', 'claim', 'Natural dyes on wool need a mordant such as alum to stay fast.'),
  // Distractors: share a word with a topic but are about something else.
  d('noise-1', 'notes', 'record', 'The harbor cafe serves fresh bread and coffee every morning.'),
  d('noise-2', 'library', 'source', 'The chain of islands is visible from the ferry on clear mornings.'),
  d('noise-3', 'notes', 'record', 'The meeting about the river festival moved to the town hall.'),
  d('noise-4', 'claims', 'claim', 'The bakery on the corner sells postcards of the lighthouse.'),
  d('noise-5', 'library', 'source', 'Stars of the film festival arrived by train in the evening.')
]);

const q = (id, query, cls, relevant, filter) => ({ id, query, class: cls, relevant, ...(filter ? { filter } : {}) });
export const relevanceQueries = Object.freeze([
  q('k-lens', 'lighthouse lens cleaning', 'keyword', { 'light-1': 2, 'light-2': 2, 'light-3': 1 }),
  q('k-tide', 'tide gauge sea level', 'keyword', { 'tide-2': 2, 'tide-1': 2 }),
  q('k-sourdough', 'sourdough starter', 'keyword', { 'bread-2': 2, 'bread-1': 2, 'bread-3': 1 }),
  q('k-chain', 'bicycle chain', 'keyword', { 'bike-1': 2, 'bike-3': 2, 'bike-2': 1 }),
  q('k-hive', 'beehive honey', 'keyword', { 'bee-1': 2, 'bee-3': 2, 'bee-2': 1 }),
  q('k-solar', 'solar panels power', 'keyword', { 'solar-1': 2, 'solar-2': 1 }),
  q('k-flood', 'river flood', 'keyword', { 'flood-1': 2, 'flood-3': 2, 'flood-2': 1 }),
  q('k-glacier', 'glacier retreat', 'keyword', { 'glacier-1': 2, 'glacier-2': 2 }),
  q('k-compost', 'compost heap leaves', 'keyword', { 'compost-1': 2, 'compost-2': 1 }),
  q('k-mirror', 'telescope mirror', 'keyword', { 'scope-1': 2, 'scope-2': 2 }),
  q('m-repairing', 'repairing bicycles', 'morphology', { 'bike-2': 2, 'bike-1': 2, 'bike-3': 1 }),
  q('m-flooding', 'flooding rivers', 'morphology', { 'flood-1': 2, 'flood-2': 1, 'flood-3': 2 }),
  q('m-migrating', 'migrating bird', 'morphology', { 'bird-2': 2, 'bird-1': 2 }),
  q('m-dyeing', 'dyeing woollen yarn', 'morphology', { 'wool-1': 2, 'wool-2': 1 }),
  q('p-honey', 'how insects turn blossom sugar into a sweet food', 'paraphrase', { 'bee-2': 2, 'bee-1': 1, 'bee-3': 1 }),
  q('p-solar', 'energy harvested from daylight on a house top', 'paraphrase', { 'solar-2': 2, 'solar-1': 1 }),
  q('p-ice', 'shrinking frozen rivers high in the mountains', 'paraphrase', { 'glacier-1': 2, 'glacier-2': 2 }),
  q('p-coast', 'beacon that warns ships after dark', 'paraphrase', { 'light-2': 2, 'light-3': 2, 'light-1': 1 }),
  q('p-loaf', 'making leavened dough at home', 'paraphrase', { 'bread-2': 2, 'bread-1': 2, 'bread-3': 1 }),
  q('f-lens-notes', 'lighthouse lens', 'filtered', { 'light-1': 2 }, { collections: ['notes'] }),
  q('f-bike-claims', 'bicycle chain', 'filtered', { 'bike-3': 2 }, { kinds: ['claim'] }),
  q('f-flood-sources', 'river flood water', 'filtered', { 'flood-2': 2 }, { collections: ['library'], kinds: ['source'] }),
  q('f-bee-records', 'honey colony', 'filtered', { 'bee-1': 2 }, { kinds: ['record'] }),
  q('f-glacier-library', 'glacier', 'filtered', { 'glacier-1': 2 }, { collections: ['library', 'notes'] })
]);
