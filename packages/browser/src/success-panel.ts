// Local-first success overview for quantum-os#289.
//
// Personal goals are supplied by the identity-scoped GoalStore. Group entries
// are projections of the active room's existing /gov state, not an alternative
// governance store. Nothing here sends messages, signs, or writes to the chain.
import type { Goal, GoalPriority } from "./goal-store.js";
import type { Group } from "./gov.js";

export const SUCCESS_PRIORITIES: readonly GoalPriority[] = [
  "urgent-important", "important", "urgent", "neither",
];

export interface SuccessGroupOverview {
  id: string;
  name: string;
  members: number;
  openIssues: number;
  hasChainReference: boolean;
  issues: { id: string; title: string; status: "open" | "closed"; hasPoll: boolean }[];
}

export interface SuccessSnapshot {
  open: Goal[];
  done: Goal[];
  buckets: { priority: GoalPriority; goals: Goal[] }[];
  groups: SuccessGroupOverview[];
}

export function successSnapshot(goals: readonly Goal[], groups: readonly Group[]): SuccessSnapshot {
  const safeGoals = goals.map(g => ({ ...g }));
  const open = safeGoals.filter(g => g.status === "open");
  const done = safeGoals.filter(g => g.status === "done");
  return {
    open,
    done,
    buckets: SUCCESS_PRIORITIES.map(priority => ({
      priority,
      goals: open.filter(g => g.priority === priority),
    })),
    groups: groups.map(g => ({
      id: g.id,
      name: g.name,
      members: Object.keys(g.members).length,
      openIssues: g.issues.filter(i => i.status === "open").length,
      hasChainReference: Boolean(g.chain?.group || g.uri),
      issues: g.issues.map(i => ({
        id: i.id, title: i.title, status: i.status, hasPoll: Boolean(i.pollId),
      })),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface SuccessPanelActions {
  addGoal(text: string, priority: GoalPriority): void;
  completeGoal(id: string): void;
  openGroup(id: string): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function renderSuccessPanel(
  host: HTMLElement, snapshot: SuccessSnapshot, actions: SuccessPanelActions,
): void {
  // textContent and createElement are intentional: group/goal names are
  // untrusted inputs, and this UI must not interpret them as markup.
  const personal = element("section", "success-section");
  personal.appendChild(element("h3", "success-heading", "Private goals"));
  personal.appendChild(element("p", "success-muted",
    String(snapshot.open.length) + " open · " + String(snapshot.done.length) +
    " completed · stored only for this dyncap identity"));

  const form = element("form", "success-add");
  const input = element("input", "success-input");
  input.type = "text";
  input.maxLength = 240;
  input.placeholder = "New personal goal";
  input.setAttribute("aria-label", "New personal goal");
  input.required = true;

  const priority = element("select", "success-select");
  priority.setAttribute("aria-label", "Goal priority");
  const priorityLabels: Record<GoalPriority, string> = {
    "urgent-important": "Urgent & important",
    important: "Important",
    urgent: "Urgent",
    neither: "Later",
  };
  for (const p of SUCCESS_PRIORITIES) {
    const option = document.createElement("option");
    option.value = p;
    option.textContent = priorityLabels[p];
    priority.appendChild(option);
  }
  priority.value = "important";
  const add = element("button", "success-action", "Add goal");
  add.type = "submit";
  form.append(input, priority, add);
  form.addEventListener("submit", e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    actions.addGoal(name, priority.value as GoalPriority);
  });
  personal.appendChild(form);

  for (const bucket of snapshot.buckets) {
    const col = element("div", "success-bucket");
    col.appendChild(element("h4", "success-bucket-title",
      priorityLabels[bucket.priority] + " (" + String(bucket.goals.length) + ")"));
    if (bucket.goals.length === 0) {
      col.appendChild(element("p", "success-muted", "No open goals"));
    }
    for (const goal of bucket.goals) {
      const item = element("div", "success-goal");
      const label = element("span", "success-goal-text", goal.text);
      const doneBtn = element("button", "success-minor", "Complete");
      doneBtn.type = "button";
      doneBtn.setAttribute("aria-label", "Complete goal " + goal.id);
      doneBtn.addEventListener("click", () => actions.completeGoal(goal.id));
      item.append(label, doneBtn);
      col.appendChild(item);
    }
    personal.appendChild(col);
  }
  if (snapshot.done.length) {
    const completed = element("details", "success-completed");
    completed.appendChild(element("summary", "", "Completed (" + String(snapshot.done.length) + ")"));
    for (const goal of snapshot.done) {
      completed.appendChild(element("p", "success-muted", "✓ " + goal.text));
    }
    personal.appendChild(completed);
  }

  const groupSection = element("section", "success-section");
  groupSection.appendChild(element("h3", "success-heading", "Groups in this room"));
  groupSection.appendChild(element("p", "success-muted",
    "Read-only view of existing /gov groups; issue status is not a verified ratification verdict."));
  if (!snapshot.groups.length) {
    groupSection.appendChild(element("p", "success-empty", "No groups in the current room."));
  }
  for (const group of snapshot.groups) {
    const card = element("article", "success-group");
    card.appendChild(element("h4", "success-group-name", group.name));
    card.appendChild(element("p", "success-muted",
      String(group.members) + " members · " + String(group.openIssues) +
      " open issues · " + (group.hasChainReference ? "chain reference configured" : "no chain reference")));
    for (const issue of group.issues) {
      card.appendChild(element("p", "success-issue",
        (issue.status === "open" ? "○ " : "✓ ") + issue.title +
        (issue.hasPoll ? " · poll linked" : "")));
    }
    const view = element("button", "success-minor", "View group");
    view.type = "button";
    view.addEventListener("click", () => actions.openGroup(group.id));
    card.appendChild(view);
    groupSection.appendChild(card);
  }
  host.replaceChildren(personal, groupSection);
}
