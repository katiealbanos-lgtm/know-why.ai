#!/usr/bin/env python3
"""
Blog post generation script for know-why.ai.
Uses Anthropic Claude API to generate SEO/GEO/AEO optimized blog posts.
Writes outputs to Supabase for the Know Why OS dashboard.
"""

import anthropic
import json
import os
import re
import time
import yaml
from datetime import datetime
from pathlib import Path
from slugify import slugify


def load_topic_bank():
    """Load predefined topic bank from JSON file."""
    topics_path = Path(".github/prompts/blog-post-topics.json")
    with open(topics_path) as f:
        return json.load(f)


def load_existing_posts():
    """Scan _posts/ to find already-written topics and avoid duplication."""
    posts_dir = Path("_posts")
    existing = []
    if posts_dir.exists():
        for post_file in sorted(posts_dir.glob("*.md")):
            with open(post_file) as f:
                content = f.read()
            if content.startswith("---"):
                fm_end = content.index("---", 3)
                fm = yaml.safe_load(content[3:fm_end])
                existing.append({
                    "title": fm.get("title", ""),
                    "category": fm.get("category", ""),
                    "tags": fm.get("tags", []),
                    "keywords": fm.get("keywords", ""),
                    "date": str(fm.get("date", "")),
                })
    return existing


def select_topic(topic_bank, existing_posts, override=None):
    """Select next topic from the bank, avoiding duplicates."""
    if override:
        return {
            "title": override,
            "category": "GTM Strategy",
            "suggested_keywords": [],
        }

    existing_titles = {p["title"].lower() for p in existing_posts}

    # Sort by priority, pick first uncovered topic
    sorted_topics = sorted(topic_bank["topics"], key=lambda t: t.get("priority", 99))
    for topic in sorted_topics:
        if topic["title"].lower() not in existing_titles:
            return topic

    # All topics covered — return None to trigger AI topic generation
    return None


def generate_fresh_topic(client, existing_posts, topic_bank):
    """Ask Claude to suggest a new topic not already covered."""
    existing_titles = "\n".join(f"- {p['title']}" for p in existing_posts)
    categories = set(t["category"] for t in topic_bank["topics"])

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": f"""Suggest ONE new blog post topic for know-why.ai, an AI-powered win/loss intelligence platform for B2B SaaS companies.

Target audience: GTM leaders (marketing, sales, RevOps, product) at mid-market B2B SaaS companies (50-1000 employees, $25M-$100M revenue).

Categories to choose from: {', '.join(categories)}

Already published topics (avoid overlap):
{existing_titles}

Respond with ONLY a JSON object:
{{"title": "...", "category": "...", "suggested_keywords": ["...", "...", "..."]}}"""
        }]
    )

    text = response.content[0].text.strip()
    # Extract JSON from response
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        return json.loads(match.group())
    return {"title": "Buyer Intelligence Best Practices for B2B SaaS", "category": "Buyer Intelligence", "suggested_keywords": ["buyer intelligence", "B2B SaaS"]}


def load_system_prompt():
    """Load the system prompt for blog post generation."""
    prompt_path = Path(".github/prompts/blog-post-system.md")
    with open(prompt_path) as f:
        return f.read()


def generate_blog_post(client, topic, existing_posts, include_download):
    """Call Claude API to generate the blog post."""
    system_prompt = load_system_prompt()

    existing_titles = "\n".join(
        f"- {p['title']} (keywords: {p.get('keywords', 'N/A')})"
        for p in existing_posts[-10:]
    )

    download_instruction = ""
    if include_download or topic.get("suggest_download"):
        download_instruction = f"""
Include downloadable content with this post. Set download: true in the front matter.
Download type: {topic.get('download_type', 'Practical framework or template (PDF)')}
Set download_url to: /downloads/[slug-matching-the-topic].pdf
Set download_description to a compelling 1-sentence description of what the reader gets.
"""

    user_prompt = f"""Generate a blog post about the following topic:

**Topic**: {topic.get('title', '')}
**Category**: {topic.get('category', 'GTM Strategy')}
**Primary Keyword** (MUST be the main keyword this post ranks for): {topic.get('primary_keyword', topic.get('suggested_keywords', [''])[0])}
**Secondary Keywords**: {', '.join(topic.get('suggested_keywords', []))}
**Search Intent**: {topic.get('search_intent', 'informational')}
**Cluster Role**: {topic.get('cluster_role', 'cluster')} (pillar = comprehensive guide, cluster = specific tactical piece)

{download_instruction}

**Recently published posts (DO NOT target their primary keywords — differentiate)**:
{existing_titles}

Generate the complete blog post in Markdown with YAML front matter.
The front matter MUST include ALL required fields per the schema in your instructions.
The date should be: {datetime.now().strftime('%Y-%m-%d')}
The content must be 1,500-2,500 words.
Include an FAQ section at the end with 4-6 questions in the front matter faq field.
Include subtle, natural references to know-why.ai where appropriate (2-3 times).

CRITICAL: Output ONLY raw Markdown starting with --- for the YAML front matter.
Do NOT output HTML. Do NOT include <!DOCTYPE html> or any HTML tags.
Do NOT wrap output in code fences. The very first characters must be ---"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )

    return response


def parse_generated_content(content):
    """Parse the generated Markdown and extract front matter metadata."""
    # Strip any markdown code fences the model might add
    content = re.sub(r'^```(?:markdown|yaml)?\n', '', content)
    content = re.sub(r'\n```$', '', content.rstrip())

    # Hard reject: if the output looks like HTML, fail loudly
    if content.lstrip().startswith('<!DOCTYPE') or '<html' in content[:200]:
        raise ValueError(
            "CRITICAL: Generated content is HTML, not Markdown. "
            "This would bypass the Jekyll layout and break blog formatting. "
            "Check the system prompt and user prompt for output format instructions."
        )

    if not content.startswith("---"):
        raise ValueError(
            "Generated content missing YAML front matter. "
            "Output must start with --- to be a valid Jekyll post."
        )

    fm_end = content.index("---", 3)
    fm = yaml.safe_load(content[3:fm_end])

    # Validate required front matter fields
    required_fields = ["layout", "title", "description", "date", "category", "author", "reading_time"]
    missing = [f for f in required_fields if not fm.get(f)]
    if missing:
        raise ValueError(f"Generated front matter is missing required fields: {missing}")

    return fm, content


def write_to_supabase(title, content, tokens_used, duration_ms):
    """Write the generated output and run log to Supabase for the Know Why OS dashboard."""
    supabase_url = os.environ.get("SUPABASE_URL", "")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY", "")

    if not supabase_url or not supabase_key:
        print("Supabase credentials not configured — skipping OS sync")
        return

    try:
        from supabase import create_client
        sb = create_client(supabase_url, supabase_key)

        # Look up Casey's agent_id
        result = sb.table("agent_registry").select("id").eq("slug", "casey").single().execute()
        agent_id = result.data["id"]

        # Insert output
        sb.table("agent_outputs").insert({
            "agent_id": agent_id,
            "output_type": "blog_post",
            "title": title,
            "content": content,
            "status": "pending_approval",
        }).execute()

        # Insert log
        sb.table("agent_logs").insert({
            "agent_id": agent_id,
            "run_status": "success",
            "tokens_used": tokens_used,
            "duration_ms": duration_ms,
            "summary": f"Generated blog post: {title}",
        }).execute()

        # Update last_run_at
        sb.table("agent_registry").update({
            "last_run_at": datetime.utcnow().isoformat(),
        }).eq("id", agent_id).execute()

        print(f"Synced to Know Why OS: output + log for '{title}'")

    except Exception as e:
        print(f"Warning: failed to sync to Supabase — {e}")
        # Don't fail the workflow over a Supabase issue


def main():
    client = anthropic.Anthropic()

    topic_override = os.environ.get("TOPIC_OVERRIDE", "").strip()
    include_download = os.environ.get("INCLUDE_DOWNLOAD", "false") == "true"

    topic_bank = load_topic_bank()
    existing_posts = load_existing_posts()

    topic = select_topic(
        topic_bank,
        existing_posts,
        override=topic_override if topic_override else None,
    )

    # If topic bank exhausted, ask Claude to suggest
    if topic is None:
        topic = generate_fresh_topic(client, existing_posts, topic_bank)

    print(f"Selected topic: {topic['title']}")
    print(f"Category: {topic.get('category', 'N/A')}")

    # Generate the post
    start_time = time.time()
    response = generate_blog_post(client, topic, existing_posts, include_download)
    duration_ms = int((time.time() - start_time) * 1000)

    raw_content = response.content[0].text
    tokens_used = response.usage.input_tokens + response.usage.output_tokens

    fm, full_content = parse_generated_content(raw_content)

    # Derive slug and filename
    date_str = datetime.now().strftime("%Y-%m-%d")
    slug = slugify(fm.get("title", topic["title"]), max_length=60)
    filename = f"{date_str}-{slug}.md"

    # Ensure _posts directory exists
    Path("_posts").mkdir(exist_ok=True)

    # Write the post file
    filepath = Path("_posts") / filename
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(full_content)

    print(f"Written: {filepath}")

    # Write metadata files for the workflow to pick up
    Path("/tmp/post_slug.txt").write_text(slug)
    Path("/tmp/post_title.txt").write_text(fm.get("title", "Untitled"))
    Path("/tmp/post_summary.txt").write_text(fm.get("description", ""))
    Path("/tmp/post_category.txt").write_text(fm.get("category", ""))
    Path("/tmp/post_keywords.txt").write_text(fm.get("keywords", ""))

    # Sync to Know Why OS
    write_to_supabase(
        title=fm.get("title", "Untitled"),
        content=full_content,
        tokens_used=tokens_used,
        duration_ms=duration_ms,
    )


if __name__ == "__main__":
    main()
