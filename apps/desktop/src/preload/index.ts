import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    create: (args: unknown) => ipcRenderer.invoke('sources:create', args),
    process: (args: unknown) => ipcRenderer.invoke('sources:process', args),
    delete: (sourceId: number) => ipcRenderer.invoke('sources:delete', sourceId),
    createText: (args: unknown) => ipcRenderer.invoke('sources:createText', args),
    bytes: (sourceId: number) => ipcRenderer.invoke('sources:bytes', sourceId),
    llmFilterGet: (sourceId: number) => ipcRenderer.invoke('sources:llmFilterGet', sourceId),
    llmFilterSet: (args: { sourceId: number; keepTerms: string[] | null }) => ipcRenderer.invoke('sources:llmFilterSet', args),
  },
  concepts: {
    bySource: (sourceId: number) => ipcRenderer.invoke('concepts:bySource', sourceId),
    tasks: (conceptId: number) => ipcRenderer.invoke('concepts:tasks', conceptId),
    mastery: (conceptId: number) => ipcRenderer.invoke('concepts:mastery', conceptId),
    misconceptions: (conceptId: number) => ipcRenderer.invoke('concepts:misconceptions', conceptId),
    equations: (conceptId: number) => ipcRenderer.invoke('concepts:equations', conceptId),
    ensureTasks: (conceptId: number) => ipcRenderer.invoke('concepts:ensureTasks', conceptId),
    regenerateTasks: (conceptId: number) => ipcRenderer.invoke('concepts:regenerateTasks', conceptId),
    sourceEvidence: (conceptId: number) => ipcRenderer.invoke('concepts:sourceEvidence', conceptId),
    delete: (conceptId: number) => ipcRenderer.invoke('concepts:delete', conceptId),
    deleteEvidenceSpan: (args: { conceptId: number; page: number; kind: string; quote: string }) =>
      ipcRenderer.invoke('concepts:deleteEvidenceSpan', args),
    enrich: (conceptId: number) => ipcRenderer.invoke('concepts:enrich', conceptId),
    updateFields: (args: { conceptId: number; definition_text?: string; why_exists?: string; what_breaks?: string; where_reappears?: string[] }) =>
      ipcRenderer.invoke('concepts:updateFields', args),
    notes: {
      list:    (conceptId: number) => ipcRenderer.invoke('conceptNotes:list', conceptId),
      create:  (args: { conceptId: number; heading: string; body?: string }) => ipcRenderer.invoke('conceptNotes:create', args),
      update:  (args: { id: number; heading?: string; body?: string }) => ipcRenderer.invoke('conceptNotes:update', args),
      delete:  (id: number) => ipcRenderer.invoke('conceptNotes:delete', id),
      reorder: (args: { conceptId: number; orderedIds: number[] }) => ipcRenderer.invoke('conceptNotes:reorder', args),
    },
  },
  evidence: {
    submit: (args: unknown) => ipcRenderer.invoke('evidence:submit', args),
    history: (conceptId: number) => ipcRenderer.invoke('evidence:history', conceptId),
    delete: (recordId: number) => ipcRenderer.invoke('evidence:delete', recordId),
    progress: () => ipcRenderer.invoke('evidence:progress'),
  },
  candidates: {
    bySource: (sourceId: number) => ipcRenderer.invoke('candidates:bySource', sourceId),
    promote:  (candidateId: number) => ipcRenderer.invoke('candidates:promote', candidateId),
    promoteBulk: (candidateIds: number[]) => ipcRenderer.invoke('candidates:promoteBulk', candidateIds),
    reject:   (candidateId: number) => ipcRenderer.invoke('candidates:reject', candidateId),
    extract:  (sourceId: number) => ipcRenderer.invoke('candidates:extract', sourceId),
  },
  review: {
    queue: (limit?: number) => ipcRenderer.invoke('review:queueList', limit),
  },
  parseRuns: {
    bySource: (sourceId: number, limit?: number) => ipcRenderer.invoke('parseRuns:bySource', sourceId, limit),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (input: unknown) => ipcRenderer.invoke('settings:set', input),
  },
});
