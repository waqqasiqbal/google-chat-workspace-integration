import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chatApi, spaceName } from "./chat.js";

function text(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "list_spaces",
    {
      title: "List spaces",
      description:
        "List Google Chat spaces (rooms and DMs) the authorized user belongs to.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Chat API filter, e.g. spaceType = "SPACE"'),
        pageSize: z.number().int().min(1).max(1000).default(100),
        pageToken: z.string().optional(),
      },
    },
    async ({ filter, pageSize, pageToken }) => {
      const chat = await chatApi();
      const res = await chat.spaces.list({ filter, pageSize, pageToken });
      return text({
        spaces: (res.data.spaces ?? []).map((s) => ({
          name: s.name,
          displayName: s.displayName,
          spaceType: s.spaceType,
        })),
        nextPageToken: res.data.nextPageToken,
      });
    }
  );

  server.registerTool(
    "get_space",
    {
      title: "Get space",
      description: "Fetch details for a single space by name or id.",
      inputSchema: { space: z.string().describe("spaces/XXXX or the bare id") },
    },
    async ({ space }) => {
      const chat = await chatApi();
      const res = await chat.spaces.get({ name: spaceName(space) });
      return text(res.data);
    }
  );

  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description:
        "Read message history from a space, newest first by default.",
      inputSchema: {
        space: z.string(),
        pageSize: z.number().int().min(1).max(1000).default(50),
        pageToken: z.string().optional(),
        filter: z
          .string()
          .optional()
          .describe('e.g. createTime > "2026-01-01T00:00:00Z"'),
        orderBy: z.string().default("createTime desc"),
      },
    },
    async ({ space, pageSize, pageToken, filter, orderBy }) => {
      const chat = await chatApi();
      const res = await chat.spaces.messages.list({
        parent: spaceName(space),
        pageSize,
        pageToken,
        filter,
        orderBy,
      });
      return text({
        messages: (res.data.messages ?? []).map((m) => ({
          name: m.name,
          text: m.text,
          createTime: m.createTime,
          sender: m.sender?.displayName ?? m.sender?.name,
          thread: m.thread?.name,
        })),
        nextPageToken: res.data.nextPageToken,
      });
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Post a message to a space. Pass threadKey to reply in an existing thread.",
      inputSchema: {
        space: z.string(),
        text: z.string(),
        thread: z
          .string()
          .optional()
          .describe("Thread name (spaces/X/threads/Y) to reply into"),
      },
    },
    async ({ space, text: body, thread }) => {
      const chat = await chatApi();
      const res = await chat.spaces.messages.create({
        parent: spaceName(space),
        requestBody: {
          text: body,
          ...(thread ? { thread: { name: thread } } : {}),
        },
        ...(thread
          ? { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" }
          : {}),
      });
      return text({ name: res.data.name, createTime: res.data.createTime });
    }
  );

  server.registerTool(
    "list_members",
    {
      title: "List members",
      description: "List the members of a space.",
      inputSchema: {
        space: z.string(),
        pageSize: z.number().int().min(1).max(1000).default(100),
        pageToken: z.string().optional(),
      },
    },
    async ({ space, pageSize, pageToken }) => {
      const chat = await chatApi();
      const res = await chat.spaces.members.list({
        parent: spaceName(space),
        pageSize,
        pageToken,
      });
      return text({
        memberships: (res.data.memberships ?? []).map((m) => ({
          name: m.name,
          role: m.role,
          state: m.state,
          member: m.member?.displayName ?? m.member?.name,
        })),
        nextPageToken: res.data.nextPageToken,
      });
    }
  );
}
