import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

export type PermissionAction = "allow" | "ask" | "deny";

export interface AppActionDef {
  description: string;
  kind: "read" | "write";
  permission: PermissionAction;
  parameters: z.ZodTypeAny;
  run(args: unknown): Promise<unknown>;
}

export interface AppDescriptor {
  name: string;
  version: string;
  description: string;
  contextQueries: string[];
  actions: Record<
    string,
    { description: string; kind: string; permission: PermissionAction }
  >;
}

export interface AppAdapter {
  readonly descriptor: AppDescriptor;
  context(query: string): Promise<unknown>;
  actions: Record<string, AppActionDef>;
}

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export class TodoAppAdapter implements AppAdapter {
  #todos: Todo[] = [];
  #nextId = 1;
  #storePath?: string;

  constructor(storePath?: string) {
    this.#storePath = storePath;
    if (storePath && existsSync(storePath)) {
      try {
        const data = JSON.parse(readFileSync(storePath, "utf8")) as {
          todos: Todo[];
          nextId: number;
        };
        this.#todos = data.todos ?? [];
        this.#nextId = data.nextId ?? this.#todos.length + 1;
      } catch {
        this.#todos = [];
      }
    }
  }

  #persist(): void {
    if (!this.#storePath) return;
    writeFileSync(
      this.#storePath,
      JSON.stringify({ todos: this.#todos, nextId: this.#nextId }, null, 2),
      "utf8",
    );
  }

  readonly descriptor: AppDescriptor = {
    name: "todo-app",
    version: "0.1.0",
    description: "A demo ordinary application: a todo list manager",
    contextQueries: ["all", "open", "done", "stats"],
    actions: {
      list_todos: {
        description: "List todos, optionally filtered by status",
        kind: "read",
        permission: "allow",
      },
      add_todo: {
        description: "Add a new todo item",
        kind: "write",
        permission: "allow",
      },
      toggle_todo: {
        description: "Toggle done state of a todo by id",
        kind: "write",
        permission: "ask",
      },
      remove_todo: {
        description: "Remove a todo by id",
        kind: "write",
        permission: "ask",
      },
    },
  };

  actions: Record<string, AppActionDef> = {
    list_todos: {
      description: this.descriptor.actions.list_todos.description,
      kind: "read",
      permission: "allow",
      parameters: z.object({
        filter: z.enum(["all", "open", "done"]).default("all"),
      }),
      run: async (args) => this.#list((args as { filter?: string }).filter ?? "all"),
    },
    add_todo: {
      description: this.descriptor.actions.add_todo.description,
      kind: "write",
      permission: "allow",
      parameters: z.object({ text: z.string().min(1) }),
      run: async (args) => this.#add((args as { text: string }).text),
    },
    toggle_todo: {
      description: this.descriptor.actions.toggle_todo.description,
      kind: "write",
      permission: "ask",
      parameters: z.object({ id: z.number().int() }),
      run: async (args) => this.#toggle((args as { id: number }).id),
    },
    remove_todo: {
      description: this.descriptor.actions.remove_todo.description,
      kind: "write",
      permission: "ask",
      parameters: z.object({ id: z.number().int() }),
      run: async (args) => this.#remove((args as { id: number }).id),
    },
  };

  async context(query: string): Promise<unknown> {
    switch (query) {
      case "stats":
        return {
          total: this.#todos.length,
          open: this.#todos.filter((t) => !t.done).length,
          done: this.#todos.filter((t) => t.done).length,
        };
      case "open":
        return this.#list("open");
      case "done":
        return this.#list("done");
      case "all":
      default:
        return { stats: await this.context("stats"), todos: this.#list("all") };
    }
  }

  #list(filter: string): Todo[] {
    if (filter === "open") return this.#todos.filter((t) => !t.done);
    if (filter === "done") return this.#todos.filter((t) => t.done);
    return [...this.#todos];
  }

  #add(text: string): Todo {
    const todo: Todo = { id: this.#nextId++, text, done: false };
    this.#todos.push(todo);
    this.#persist();
    return todo;
  }

  #toggle(id: number): Todo | { error: string } {
    const todo = this.#todos.find((t) => t.id === id);
    if (!todo) return { error: `todo ${id} not found` };
    todo.done = !todo.done;
    this.#persist();
    return todo;
  }

  #remove(id: number): { removed: boolean } {
    const before = this.#todos.length;
    this.#todos = this.#todos.filter((t) => t.id !== id);
    const removed = this.#todos.length < before;
    if (removed) this.#persist();
    return { removed };
  }
}
