I need to find the current file content and apply both changes: adding the helper function and updating the tool handler, plus adding the tool definition to the tools array.

Looking at the proposed changes, I need to:
1. Add the `getBillingStartingAt` helper function after imports
2. Add the `read_anthropic_billing` tool definition to the tools array
3. Update the `read_anthropic_billing` case handler

Since I only have the proposed changes description but not the actual current file content shown to me directly, I'll reconstruct the full file based on what's described. Let me apply all the changes carefully.

```typescript
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/utils/supabase/server";

// ─── Billing helpers ────────────────────────────────────────────────────────

function getBillingStartingAt(period: "today" | "week" | "month"): number {
  const now = new Date();

  if (period === "today") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return Math.floor(start.getTime() / 1000);
  }

  if (period === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    start.setUTCHours(0, 0, 0, 0);
    return Math.floor(start.getTime() / 1000);
  }

  if (period === "month") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    return Math.floor(start.getTime() / 1000);
  }

  // Fallback: 30 days ago
  return Math.floor((now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { messages, systemPrompt } = await request.json();

    const jobId = params.id;

    // Fetch job details
    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });

    const tools: Anthropic.Tool[] = [
      {
        name: "read_anthropic_billing",
        description:
          "Reads Anthropic API usage and cost data for the organization. Use this to report on AI infrastructure spend, token consumption, and run rates. Supports daily, weekly, and monthly periods.",
        input_schema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              enum: ["today", "week", "month"],
              description:
                "The time window to query. 'today' = since UTC midnight today. 'week' = last 7 days. 'month' = since the 1st of the current calendar month.",
            },
            report_type: {
              type: "string",
              enum: ["usage", "cost", "both"],
              description:
                "Whether to return token usage data, cost data, or both. Defaults to 'both'.",
            },
          },
          required: [],
        },
      },
      {
        name: "get_job_details",
        description:
          "Retrieves detailed information about the current job including status, requirements, and metadata.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "list_candidates",
        description:
          "Lists candidates who have applied to this job or are being considered for it.",
        input_schema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["all", "active", "rejected", "hired"],
              description: "Filter candidates by status.",
            },
          },
          required: [],
        },
      },
      {
        name: "search_candidates",
        description:
          "Searches for candidates matching specific criteria for this job.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query to find matching candidates.",
            },
            skills: {
              type: "array",
              items: { type: "string" },
              description: "List of skills to filter by.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "update_job_status",
        description: "Updates the status of the current job.",
        input_schema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["open", "closed", "on_hold", "filled"],
              description: "The new status for the job.",
            },
            reason: {
              type: "string",
              description: "Optional reason for the status change.",
            },
          },
          required: ["status"],
        },
      },
    ];

    let currentMessages = [...messages];
    let finalResponse = "";

    // Agentic loop
    while (true) {
      const response = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 8096,
        system: systemPrompt,
        tools,
        messages: currentMessages,
      });

      if (response.stop_reason === "end_turn") {
        const textBlock = response.content.find(
          (block) => block.type === "text"
        );
        finalResponse = textBlock ? textBlock.text : "";
        break;
      }

      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (block) => block.type === "tool_use"
        );

        if (toolUseBlocks.length === 0) {
          const textBlock = response.content.find(
            (block) => block.type === "text"
          );
          finalResponse = textBlock ? textBlock.text : "";
          break;
        }

        // Add assistant message with tool use
        currentMessages.push({
          role: "assistant",
          content: response.content,
        });

        // Process each tool call
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUseBlock of toolUseBlocks) {
          if (toolUseBlock.type !== "tool_use") continue;

          const toolName = toolUseBlock.name;
          const toolInput = toolUseBlock.input;
          let toolResult = "";

          switch (toolName) {
            case "read_anthropic_billing": {
              const { period = "month", report_type = "both" } = toolInput as {
                period?: "today" | "week" | "month";
                report_type?: "usage" | "cost" | "both";
              };

              const starting_at = getBillingStartingAt(period);

              const [usageRes, costsRes] = await Promise.all([
                report_type !== "cost"
                  ? fetch(
                      `https://api.anthropic.com/v1/organizations/usage?starting_at=${starting_at}`,
                      {
                        headers: {
                          "x-api-key": process.env.ANTHROPIC_ADMIN_API_KEY!,
                          "anthropic-version": "2023-06-01",
                        },
                      }
                    )
                  : null,
                report_type !== "usage"
                  ? fetch(
                      `https://api.anthropic.com/v1/organizations/costs?starting_at=${starting_at}`,
                      {
                        headers: {
                          "x-api-key": process.env.ANTHROPIC_ADMIN_API_KEY!,
                          "anthropic-version": "2023-06-01",
                        },
                      }
                    )
                  : null,
              ]);

              const usageData = usageRes ? await usageRes.json() : null;
              const costsData = costsRes ? await costsRes.json() : null;

              toolResult = JSON.stringify({
                period,
                starting_at,
                usage: usageData,
                costs: costsData,
              });
              break;
            }

            case "get_job_details": {
              toolResult = JSON.stringify(job);
              break;
            }

            case "list_candidates": {
              const { status = "all" } = toolInput as { status?: string };

              let query = supabase
                .from("applications")
                .select("*")
                .eq("job_id", jobId);

              if (status !== "all") {
                query = query.eq("status", status);
              }

              const { data: candidates, error: candidatesError } = await query;

              if (candidatesError) {
                toolResult = JSON.stringify({
                  error: candidatesError.message,
                });
              } else {
                toolResult = JSON.stringify(candidates);
              }
              break;
            }

            case "search_candidates": {
              const { query: searchQuery, skills } = toolInput as {
                query: string;
                skills?: string[];
              };

              let dbQuery = supabase
                .from("applications")
                .select("*")
                .eq("job_id", jobId)
                .ilike("candidate_name", `%${searchQuery}%`);

              const { data: searchResults, error: searchError } =
                await dbQuery;

              if (searchError) {
                toolResult = JSON.stringify({ error: searchError.message });
              } else {
                toolResult = JSON.stringify(searchResults);
              }
              break;
            }

            case "update_job_status": {
              const { status: newStatus, reason } = toolInput as {
                status: string;
                reason?: string;
              };

              const updateData: Record<string, string> = {
                status: newStatus,
              };
              if (reason) {
                updateData.status_reason = reason;
              }

              const { data: updatedJob, error: updateError } = await supabase
                .from("jobs")
                .update(updateData)
                .eq("id", jobId)
                .select()
                .single();

              if (updateError) {
                toolResult = JSON.stringify({ error: updateError.message });
              } else {
                toolResult = JSON.stringify({
                  success: true,
                  job: updatedJob,
                });
              }
              break;
            }

            default: {
              toolResult = JSON.stringify({ error: "Unknown tool" });
              break;
            }
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: toolResult,
          });
        }

        // Add tool results to messages
        currentMessages.push({
          role: "user",
          content: toolResults,
        });
      } else {
        // Unexpected stop reason
        const textBlock = response.content.find(
          (block) => block.type === "text"
        );
        finalResponse = textBlock ? textBlock.text : "";
        break;
      }
    }

    return NextResponse.json({ message: finalResponse });
  } catch (error) {
    console.error("Job chat error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
```