import type { AdapterDescriptor, AdapterId } from "./types.js";

const descriptors: Record<AdapterId, AdapterDescriptor> = {
  odorik: {
    id: "odorik",
    name: "Odorik",
    description: "Recorded phone calls, audio, transcripts, and call metadata.",
    resourceNoun: "phone numbers",
    available: true,
    availability: "available",
    readOnly: true,
  },
  google_calendar: {
    id: "google_calendar",
    name: "Google Calendar",
    description: "Events from calendars explicitly selected after Google authorization.",
    resourceNoun: "calendars",
    available: true,
    availability: "available",
    readOnly: true,
  },
  google_drive: {
    id: "google_drive",
    name: "Google Drive",
    description: "Documents inside explicitly selected folders.",
    resourceNoun: "folders",
    available: false,
    availability: "planned",
    readOnly: true,
  },
  gmail: {
    id: "gmail",
    name: "Gmail",
    description: "Messages carrying one explicitly selected Gmail label.",
    resourceNoun: "labels",
    available: false,
    availability: "planned",
    readOnly: true,
  },
  github: {
    id: "github",
    name: "GitHub Issues",
    description: "Issues and comments from explicitly selected repositories.",
    resourceNoun: "repositories",
    available: false,
    availability: "planned",
    readOnly: true,
  },
};

export function adapterCatalog(): AdapterDescriptor[] {
  return Object.values(descriptors);
}
