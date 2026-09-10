export interface FAQDraftInput {
  title: string;
  category: string;
  tags: string[];
  keywords: string[];
  question: string;
  answer: string;
}

export interface ActorInfo {
  id: string;   // Discord user ID
  name: string; // Discord display name
}

// Typed payloads stored in PendingAction.payload
export interface FAQCreatePayload {
  channelId: string;
  draft: FAQDraftInput;
}

export interface FAQUpdatePayload {
  channelId: string;
  faqId: string;
  changes: Partial<FAQDraftInput>;
}

export interface FAQDeletePayload {
  channelId: string;
  faqId: string;
}
