# Tesseract Framework and SDK Implementation Plan

> Historical document — superseded by [Minimal Core Plan](2026-10-15-tesseract-minimal-core-plan.md) and its English spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây framework/SDK độc lập để dev tạo CLI agent hoặc nhúng agent vào application qua cùng Agent engine, state và plugin ecosystem.

**Architecture:** Package @tesseract/core sở hữu Agent/Controller/Session/Thread, loop, state, typed extension points và durable execution; public exports là SDK cho dev. Provider protocol và nơi lưu state là integrations qua public contracts. Thực hiện ba kế hoạch nối tiếp; mỗi phần có deliverable và test gate riêng.

**Tech Stack:** Node.js >=24.14.0, pnpm 11.5.3, TypeScript 7.0.2, Vitest 5.0.4, ESM/NodeNext; node:sqlite và OpenAI SDK 7.34.0 chỉ ở integration packages.

**Spec:** [Public API/state machine](../specs/2026-10-15-tesseract-public-api-state-machine-design.md), [core](../specs/2026-10-14-tesseract-core-design.md), [state](../specs/2026-10-14-tesseract-state-design.md), [notes](../../architecture-notes.md). Khi snippets cũ xung đột, public API/state machine là contract ưu tiên.

**Cập nhật 2026-10-15 — ponytail từ đầu:** Rà lại cả A/B/C đã viết theo
ponytail (full), giữ các hành vi người dùng đã chốt. Danh sách file và các
abstraction trong subplans là lựa chọn triển khai để xét lại, không phải
yêu cầu tạo đủ tầng. Event names là strings; constants và type map phục vụ
autocomplete/type safety, thay event definition objects. Giảm code và
dependency thực tế; chia file hoặc đổi tên đơn thuần không thay thế việc
giản lược. Không xóa code hoặc làm lại workspace từ đầu theo nghĩa vật lý.
Các kết quả kiểm thử cũ chỉ chứng minh phiên bản đã chạy; mọi thay đổi cần
kiểm tra lại hành vi bị tác động.

## Global Constraints

- Tesseract độc lập Cube/Mastra/Pi; không dùng engine của các framework đó.
- Core không có third-party production dependencies, không import filesystem, provider SDK hoặc SQLite; Agent/Controller/Session nằm trong core.
- Một package chính @tesseract/core cung cấp SDK; không tạo @tesseract/sdk, SDK runtime hoặc RuntimePort để nối các thành phần core.
- Agent trực tiếp sở hữu loop; Controller sở hữu lifecycle/resources; Session tương tác với cùng Agent. Không tạo class engine bọc bên dưới Agent.
- Storage/checkpoint luôn có sẵn; memory backend default, SQLite reference backend qua node:sqlite trong package riêng.
- Agent và Controller bắt buộc id do dev định danh; Session không có public id.
- Agent có immutable default model; Session có model selection riêng; không truyền model lặp lại ở mỗi call.
- Session dùng subscribe/followUp/abort/resume/recover và session.thread.switch; không thêm send/stream public.
- Scope là flat scalar metadata/filter, không phải identity hay authorization.
- Canonical writes là required; không hứa exactly-once external effects hoặc event delivery.
- Runtime baseline: Node.js >=24.14.0; pnpm 11.5.3.
- TypeScript 7.0.2, Vitest 5.0.4; ESM/NodeNext, strict, declaration exports.
- Defaults: 32 turns, 64 model attempts, 128 tool calls; iterator buffer 512 events hoặc 4 MiB; pagination 50 mặc định, tối đa 200; profile TTL 24 giờ.
- Test default offline/deterministic; live provider smoke opt-in theo environment.
- Out of scope: migration Cube, full coding CLI/TUI, application backend/auth, compression/skills/memory/subagent product policies và TD-001 installer/loader.

## Review Focus

1. Hai processes dùng cùng Controller.id tranh lease: fencing riêng chặn owner cũ; A6/B3.
2. Publish đã commit nhưng response mất: commitId xác nhận kết quả, không chạy model/tool lại; A4/B3.
3. Hai Sessions cùng scope không chia selection/subscribers/queue: C4.
4. Resume sau đổi model/plugin: giữ decisions/usage cũ và validate request mới, thiếu required contract giữ suspended; B2/B5/C3.
5. Child orchestration crash sau dispatch: giữ lineage, không tự spawn lại unknown child; B5/C5.

---

## Hiện trạng và cách thực hiện

Đây là plan gốc trước khi triển khai. Workspace hiện đã có source và Git;
tiến độ cùng bằng chứng kiểm thử được ghi trong execution ledger. Cập nhật
ponytail ở trên áp dụng cả các phần đã triển khai. Không diễn giải check
Markdown thành kết quả build/runtime.

Thực hiện A → B → C theo thứ tự; không làm song song các phần đang thay đổi
contracts chung. Mỗi task có vòng test fail → implement → pass → commit.
Không làm setup/scaffolding thành một deliverable rỗng.

| Phần | Deliverable có thể kiểm chứng | Gate |
| --- | --- | --- |
| [A — Core contracts và storage](2026-10-15-tesseract-core-storage-plan.md) | Message/tool/event primitives, plugin host, state APIs, memory/SQLite cùng conformance | Core tests và SQLite child-process tests |
| [B — Durable engine](2026-10-15-tesseract-durable-engine-plan.md) | Model/tool loop, checkpoints, interruption/recovery, cancellation và tracked child operations | Scripted-model fault-injection suite |
| [C — SDK và integrations](2026-10-15-tesseract-sdk-integrations-plan.md) | Agent/Controller/Session, automatic profiles, OpenAI helper, external plugins và CLI/headless examples | Public-import tests, offline integration, built examples |

## Package và file ownership

~~~text
package.json, pnpm-workspace.yaml, pnpm-lock.yaml
tsconfig.json, tsconfig.base.json, vitest.config.ts
scripts/check-boundaries.mjs
packages/core/
  src/messages/{message,parts,codec}.ts
  src/instructions/instruction.ts
  src/tools/{tool,input-definition}.ts
  src/models/{contract,profile,registry,resolver,cache,catalog}.ts
  src/models/catalog.snapshot.json
  src/events/{definition,catalog,dispatcher}.ts
  src/plugins/{context,host,registry}.ts
  src/state/{schema,scope,storage-ports,memory-backend,commit,queries,fork,plugin-state}.ts
  src/trace/{records,usage}.ts
  src/engine/{context,tool-executor,interrupt,resume,recovery,delivery,tracked-effects}.ts
  src/{agent,controller,thread,session,session-thread,session-events}.ts
  src/testing/{scripted-provider,harness,storage-conformance}.ts
  src/{index,errors,json}.ts
packages/sqlite/
  src/{backend,schema,ownership,index}.ts
packages/openai/
  src/{plugin,adapter,codec,metadata,index}.ts
examples/
  cli/{package.json,tsconfig.json,src/main.ts}
  headless/{package.json,tsconfig.json,src/main.ts}
  plugins/{skills,memory,commands,subagents}/index.ts
tests/integration/{sqlite-process,public-imports,examples,plugin-ecosystem}.test.ts
tests/fixtures/{sqlite-worker,child-agent-worker}.ts
README.md, docs/plugin-authoring.md, .github/workflows/ci.yml
~~~

Mỗi package có package.json/tsconfig.json và test files do subplan chỉ rõ.
Mỗi nhóm có một trách nhiệm; index.ts chỉ reexport, không initialize hoặc I/O.
Agent/Controller/Session và Thread dùng trực tiếp cùng agent loop trong core.
Không thêm bridge runtime hoặc package trung gian. Core không import provider
protocol implementations hoặc database drivers.
Testing exports nằm ở subpath /testing, không tràn vào production barrel.

Dependency DAG:

~~~text
sqlite → core ← provider-openai
                    ↑
      examples / external plugin proofs / integration tests
~~~

Provider helper dùng normalized core metadata/resolver contracts; core cung
cấp model registry/cache qua public SDK. Source đang ở packages/sdk cần được
chuyển vào core và kiểm thử trước khi bỏ package trung gian đó.
Tên package dùng trong workspace, chưa phải cam kết publish npm scope.

## Quy ước test, build và commits

- Tên test code trong subplans là acceptance contract; fixture helpers là
  exported APIs được task sở hữu định nghĩa, không dùng private imports.
- Root Vitest alias map workspace package names đến src để test source;
  public-import/package smoke riêng phải chạy dist theo exports thực.
- Root build dùng pnpm -r build theo workspace dependency graph; typecheck
  dùng pnpm -r typecheck. Tests có typecheck riêng để @ts-expect-error được kiểm.
- Root scripts: build, typecheck, test, test:integration, check:boundaries.
  test chạy package suites; test:integration chạy tests/integration riêng,
  không lặp toàn bộ package suite.
- Khi thực thi task A1, kiểm tra lại root bằng git rev-parse. Nếu vẫn chưa có
  repository, git init tại D:/Tesseract trước commit đầu. Không làm việc này
  trong phase viết plan.
- Commit từng task chỉ exact files của task; không git add toàn workspace,
  không commit .env/API keys/catalog chứa credentials hay artifacts SQLite.
- Chỉ chạy live OpenAI smoke khi host đã cấp environment key; mocked HTTP/SSE
  là gate bắt buộc, live network không là điều kiện pass mặc định.

## Contract checkpoints giữa các phần

A kết thúc khi schemas, StorageBackend ports, typed decisions và PluginContext
compile cùng nhau; hai backends qua cùng conformance. B dùng đúng các ports
đó để chứng minh loop/recovery trước khi SDK che chúng bằng convenience APIs.
C chỉ compose engine, không dựng agent loop mới.

Agent.generate được kiểm bằng đối chiếu cùng records với Agent.stream.
Session.followUp trả nhận input/queue, không trả aggregate model result.
Session.resume/recover trả receipt sau durable admission, còn events đi qua
subscription. Queue chưa admit nằm trong memory và không được hứa survive restart.

## Coverage theo spec

| Nhóm contract | Tasks |
| --- | --- |
| Message, instructions, Tool/createTool, reasoning/provider state | A1/A3, B1, C2 |
| Typed/custom events, policies, ordering, dynamic plugin generations | A2, B1/B5 |
| Scope, state schema, plugin state, getHistory, fork | A4/A5/A6 |
| Turn/attempt/tool trace, tokens/cache/reasoning, direct/child accounting | A3, B1/B3/B5 |
| Commit, ownership, fencing, required storage failure behavior | A4/A6, B1/B3 |
| HITL, response CAS, cursor, compatibility, model override | B2/B3/B5, C4 |
| Abort, disconnect, overflow, finalization | B4, C3/C4 |
| Agent/Controller identity, lifecycle, default model | C3 |
| Model.profile auto resolution, unknown/offline/tiered pricing | C1/C2 |
| Session lifecycle/events/thread operations/followUp | C4 |
| Skills/memory/slash/subagents qua public plugin SDK | B5/C5 |
| CLI/headless packaging, public imports và architecture boundaries | C6 |

## Exit gate và evidence

- [ ] A1–A6 hoàn tất, core/storage conformance pass.
- [ ] B1–B5 hoàn tất, deterministic crash/recovery tests pass.
- [ ] C1–C6 hoàn tất, SDK/integration/examples pass.
- [ ] pnpm install --frozen-lockfile
- [ ] pnpm typecheck
- [ ] pnpm build
- [ ] pnpm test
- [ ] pnpm test:integration
- [ ] pnpm check:boundaries
- [ ] Review diff và package exports; không import engine internals từ proof plugins.
- [ ] Ghi rõ bằng chứng code inspection/test/process execution và live-provider
      smoke đã chạy hay chưa. Không ghi “production-ready” từ các gates trên.

## Self-review của plan

Đã map public API/state machine sections 3–15 tới tasks trong coverage table;
baseline kỹ thuật ở section 16. Đã kiểm tra Session không có stream/send/id,
Agent và Controller required id, model default/override, storage luôn có sẵn,
plugin backend chỉ chọn nơi lưu và TD-001 được hoãn.

Review Focus có owning tests ở subplans; commit commands chỉ các files của
task. Các testing harness APIs được task sản xuất chỉ rõ. Chưa có test,
build hoặc runtime execution vì đây là kế hoạch trước implementation.
