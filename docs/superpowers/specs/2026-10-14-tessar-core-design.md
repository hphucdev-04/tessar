# Tessar: core, SDK và hệ sinh thái plugin

> Historical document — superseded by [Minimal Core Design](2026-10-15-tessar-minimal-core-design.md) and its English implementation plan.

> 2026-10-16 API update: plugin composition belongs to
> `new Controller({ id, agent, plugins })`. Older Agent plugin/factory examples
> below are historical and do not describe the current public API.

Cập nhật sau review: đã chốt Controller sở hữu public initialize/runtime,
controller.createSession và nhóm session.thread.* cùng subscribe/abort/followUp.
Các đoạn Agent lifecycle/new Session/direct Session thread methods trong
bản brainstorm dưới đây là thiết kế trước quyết định này. Public API hiện
tại và ownership mới theo
[public API/state machine](2026-10-15-tessar-public-api-state-machine-design.md).
Không dùng các snippets cũ làm API cuối cùng cho implementation. Ngày
2026-10-15 người dùng đã chốt bản contract mới và yêu cầu implementation plan.
Agent có model mặc định; Session dùng subscribe/followUp/resume/recover,
không public stream/send; chọn Thread qua session.thread.switch.

Ngày: 2026-10-14.

Trạng thái: bản nháp để thảo luận. Mục tiêu, tính độc lập, agent loop tự xây,
ranh giới core tổng quát, backend tự tích hợp, Thread tách khỏi host Session,
execution trace/usage nền tảng và API nền `new Agent(...)` đã
được thống nhất. Các signatures, lifecycle và hành vi cụ thể dưới đây là
đề xuất, chưa phải API đã triển khai hoặc thiết kế đã duyệt đầy đủ.

Bản cụ thể hóa ngày 2026-10-15:
[public API và state machine](2026-10-15-tessar-public-api-state-machine-design.md).
Tài liệu đó đưa ra signatures, defaults, checkpoint/interrupt schema và
transitions đã chốt; chưa phải implementation. Khi review signatures/lifecycle cụ thể, dùng
bản contract mới thay vì coi các ví dụ cũ dưới đây là API cuối cùng.

Định hướng hiện tại 2026-10-15: provider integrations qua plugin; SDK cung
cấp adapters/helpers để dev tự viết plugin. Với CLI multi-model, Session
sở hữu model selection; Thread sở hữu hội thoại. Chi tiết APIs dưới đây
vẫn là đề xuất để review.

## 1. Mục tiêu và người sử dụng

Tessar là framework và SDK độc lập cho người xây dựng ứng dụng agent:

- Người xây CLI agent: tự chọn terminal UI, commands, tools và workflow.
- Người nhúng agent vào application: tự chọn giao diện, transport, danh tính
  người dùng, cách lưu dữ liệu và cách vận hành.

Backend tự tích hợp SDK vào framework/server của họ, tự quản lý
authentication, request lifecycle và transport. Tessar không yêu cầu
một backend server do framework cung cấp.

Cả hai dùng cùng một engine và plugin API. Một plugin provider hoặc tool có
thể được dùng trong cả CLI lẫn application nếu không phụ thuộc host cụ thể.
Plugin phụ thuộc terminal phải khai báo hoặc yêu cầu host terminal rõ ràng.

Cube là một ứng dụng sử dụng hệ sinh thái Tessar. Mục tiêu chuyển Cube khỏi
Mastra thuộc về tích hợp ứng dụng, không quyết định cấu trúc framework.

Triết lý: core cung cấp cơ chế tối thiểu; plugin cung cấp khả năng và chính
sách. Tessar tự sở hữu agent loop và lấy cảm hứng từ pi.dev về khả năng mở rộng.

Lưu ý đã xác nhận: chỉ core là nền tảng bắt buộc. Các khả năng khác có thể
được bổ sung sau qua plugin/integration mà không phải sửa engine hoặc làm
gián đoạn hoạt động hiện có của core. CLI/application đóng gói sẵn defaults
và plugins vẫn phải mở rộng được bởi người dùng; Pi CLI là ví dụ người dùng
đưa ra cho hình thức sản phẩm này.

Quy tắc attach/detach đã chốt: Stream giữ bộ plugin và registrations lúc
bắt đầu; thay đổi chỉ áp dụng cho Streams mới. Dispose plugin chờ execution
đang sử dụng kết thúc. Chi tiết API và hot reload/package loading vẫn cần
thiết kế riêng.

## 2. Các lớp và hướng phụ thuộc

```text
CLI / desktop / backend application
                  |
             Public SDK
                  |
       Core contracts + agent loop
                  ^
                  |
        Plugins implement contracts
```

Core execution không import plugin, terminal renderer hoặc code của application.
SDK là bề mặt công khai cho người phát triển: `Agent`, tạo thread, chạy,
nhận events và giải phóng tài nguyên. SDK không có một agent loop riêng.
Các factory chuyên biệt như `createCodingAgent(...)` cấu hình cùng lớp
`Agent` bằng các plugin; tính năng coding nằm ở lớp mở rộng này.

Plugin chính thức và plugin bên thứ ba dùng cùng contracts và điểm mở rộng.
Một plugin mới không được cần quyền truy cập đặc biệt chỉ vì do dự án phát hành.

Các nhóm package dự kiến:

| Nhóm | Trách nhiệm |
| --- | --- |
| Core | Contracts, state machine, agent loop, plugin host và storage/state management có sẵn |
| SDK | API lập trình và helpers dựa trên core |
| Agent presets | Các factory chuyên biệt ghép plugins và defaults, trả về Agent |
| Model SDK modules | ModelProvider/ModelAdapter contracts, provider helpers và tự resolve metadata cho model.profile |
| Provider plugins | Đăng ký providers/model bindings, auth và model integrations |
| Storage backend plugins | Chọn nơi lưu dữ liệu và triển khai backend I/O theo storage contracts của core |
| Capability/policy plugins | Tools, context, permissions và các khả năng khác |
| Host integrations | Terminal rendering hoặc transport của ứng dụng |

Đây là ranh giới logic. Chưa chốt npm scope hoặc bắt buộc mỗi nhóm là một
package riêng; việc chia package phải có lý do sử dụng và phát hành cụ thể.

## 3. Agent, thread và stream

### Agent

`Agent` là class nền, giữ cấu hình engine: provider/model registries, tools, plugins,
instructions mặc định và giới hạn lượt chạy. Một instance mới được construct
chưa có nghĩa plugin setup đã hoàn tất. Agent không chứa một hội thoại
chung cho tất cả người dùng.

Agent sở hữu registry và lifecycle của các tài nguyên nó khởi tạo. Registry
ban đầu được hoàn tất trước khi agent sẵn sàng. Registry có thể được cập
nhật cho Streams mới; bộ plugin của một Stream đang chạy được giữ ổn định.

### Thread

Agent sở hữu instructions nền, nhận string hoặc Instruction từ SDK helper
buildInstruction. Thread có thể bổ sung instructions; Session không thêm
lớp instructions riêng. Core snapshot effective config cho execution.

Thread là một hội thoại: messages, instructions bổ sung của hội thoại và trạng thái
thực thi liên quan. Storage và state management có sẵn trong core, mặc định
dùng backend trong bộ nhớ. Plugin chỉ chọn backend lưu dữ liệu khác.

Một agent có thể tạo nhiều thread. Messages và stream state không chia sẻ giữa
các thread. Plugin có state riêng phải phân biệt state cấp agent, thread
và stream, thay vì sử dụng biến toàn cục làm state hội thoại.

Quy tắc đã chốt: mỗi Thread chỉ có một Stream hoạt động tại một thời điểm.
Gọi Stream thứ hai khi Thread đang chạy trả lỗi `ThreadBusy`; core không
tự xếp hàng input. Application hoặc plugin có thể bổ sung queue. Các
Threads khác nhau chạy đồng thời trên cùng Agent; subagent dùng Thread riêng.

### Stream

Stream là một lần xử lý input, có thể gồm nhiều lượt model và tool. Stream có ID,
kết quả cuối, events và cancellation riêng. Request context thuộc về stream,
ví dụ actor ID hoặc request ID; không tự động đưa context này vào prompt.

`Stream` biểu diễn toàn bộ execution của agent và phát updates trong suốt
execution. Một model stream ở tầng adapter chỉ là một phần của một model
attempt; một Stream của agent có thể chứa nhiều model attempts và tool calls.
IDs/context/event names của lượt thực thi dùng thuật ngữ stream nhất quán.

Một stream kết thúc đúng một lần với trạng thái completed, cancelled, failed
hoặc stopped vì giới hạn. Dừng vì giới hạn không được báo là hoàn thành.

Core cũng hỗ trợ trạng thái suspended để chờ external input/HITL và cơ chế
recovery sau gián đoạn. Core lưu checkpoint/execution position cùng pending
request trước khi phát AgentEvents.StreamSuspended và kết thúc lượt đọc
events hiện tại. Suspended không phải terminal outcome của execution.

Resume tiếp tục cùng streamId, trả Stream handle mới cho lượt đọc events
tiếp theo. Không cần giữ handle/connection/Promise cũ qua thời gian chờ hoặc
restart. Core validate phản hồi, checkpoint, quyền thực thi và capabilities
cần cho bước tiếp theo; không chạy lại bước đã ghi nhận hoàn tất hay tính lại
usage cũ. Model có thể đổi tường minh khi resume, kiểm tra request compatibility
ở boundary trước lời gọi model mới, không khóa model theo checkpoint.

### Session của host/SDK

Session là lớp host/SDK tùy chọn quản lý một phiên sử dụng, các threads đang
mở và model đang chọn. Backend có thể dùng Agent/Thread/Stream trực tiếp
với model selection tường minh hoặc tạo Session theo scope riêng của app.
State của phiên CLI không được gộp vào snapshot hội thoại hoặc bắt backend
phải lưu một phiên tương đương process.

Session model selection/preferences là state có scope metadata. Runtime
Agent và registries có thể dùng chung; application dùng fields do nó định
nghĩa để filter state theo user/workspace hoặc nhóm dữ liệu tương ứng.

Trong CLI multi-model, `session.setModel(...)` là nơi đổi lựa chọn của phiên.
Thread không sở hữu một current model preference mặc định. `session.stream`
ủy quyền cho engine/thread với model selection đã được chụp tại admission.
Đổi model trong Session áp dụng cho streams mới, không thay request đang
stream hoặc âm thầm thay các lượt tiếp của stream hiện tại.
Resume mặc định giữ selection trước đó, nhưng cho phép dev đổi model tường
minh cho request tiếp theo; đây không phải thay đổi âm thầm từ Session.

Router plugin có thể yêu cầu một binding khác qua ModelSelect ở boundary
đã định nghĩa, với capability/context compatibility checks. Đây là policy
tường minh của stream, khác với việc đổi lựa chọn hiện tại của Session.

### 3.1. Nơi giữ state và persistence

Ranh giới đã chốt: storage/state management là chức năng có sẵn của framework;
plugin chỉ chọn backend lưu dữ liệu. Schema/signatures chi tiết vẫn là bản nháp.

| State | Chủ sở hữu | Mặc định |
| --- | --- | --- |
| Messages, instructions, thread revision | Thread; core kiểm soát mutations | Trong bộ nhớ |
| Stream status, cancellation, stream assembly | Stream | Trong bộ nhớ, theo lifecycle execution |
| Turn/model attempt/tool execution records và usage | Core execution recorder và storage | Lưu qua backend trong bộ nhớ mặc định hoặc backend được chọn |
| State riêng của plugin | Plugin định nghĩa nội dung; core quản lý lưu state theo agent/thread/stream owners | Lưu qua storage có sẵn, theo backend được chọn |
| Current model và preferences của phiên CLI | Host Session | Trong bộ nhớ; host/plugin chọn persistence riêng |

Core cung cấp storage service và backend trong bộ nhớ mặc định: logical
schema, mutations/revisions, commit boundaries, checkpoints, serialize/restore,
query/filter và fork. Backend plugin thực hiện I/O và consistency primitives
cho nơi lưu được chọn, không bổ sung một lifecycle persistence riêng bằng
event handlers. CLI có thể chọn file/SQLite; backend application có thể
chọn PostgreSQL/MongoDB hoặc backend adapter riêng. Core không quy định một
thư mục, database hoặc backend service bắt buộc. Dữ liệu chỉ tồn tại qua
restart khi chọn backend có khả năng lưu bền vững.

Durable snapshot gồm schema version, thread identity/revision, messages và
các trường serializable đã công bố. Plugin state có namespace theo plugin ID
và version riêng; không tự đưa state đó vào prompt hoặc messages.

Snapshot không chứa AbortController, Promise, connection hoặc plugin
instances. Phục hồi snapshot tái tạo một thread hợp lệ để tiếp tục hội thoại;
nó không tự chứng minh khả năng resume một tool đang chạy qua process restart.

Core định nghĩa consistency/failure contract; backend implementations phải
đáp ứng contract đó và công bố capabilities/limitations.
Expected revision giúp tránh ghi đè state cũ; chạy cùng thread từ nhiều
process còn cần ownership/lease riêng để tránh execution trùng nhau.

Schema chi tiết cho thread state, execution records, token/cache metrics và
quy tắc aggregation nằm trong
[state design](2026-10-14-tessar-state-design.md). Execution trace và usage
là dữ liệu core; telemetry exporter là plugin. ThreadStore và ExecutionStore
là các logical backend ports phía sau storage service có sẵn của core, có
thể được một adapter cung cấp chung; không bắt buộc hai databases hoặc hai
plugins. Checkpoint coordination và restore thuộc core, không thuộc backend.

### 3.1.1. Checkpoint và durable execution

Đã chốt ngày 2026-10-15: core cung cấp checkpoint, suspend/resume và recovery
tại các boundary xác định ngay từ đầu, thay vì chỉ restore history/fork.
Checkpoint là nền tảng state; runtime phải quản lý transitions để tiếp tục
execution từ dữ liệu đã lưu, không cố khôi phục một Promise hay call stack.

Với HITL, core lưu trạng thái suspended, execution position và yêu cầu có ID
đang chờ phản hồi. Core validate/correlate phản hồi, bảo đảm một phản hồi
không bị áp dụng trùng, rồi resume dưới quyền thực thi hợp lệ. Plugin chọn
khi nào yêu cầu can thiệp và policy xử lý; host sở hữu UI/transport.

Với fault tolerance, core ghi nhận các bước hoàn tất và vị trí gián đoạn,
quản lý quyền recovery/resume để tránh hai processes cùng tiếp tục Thread.
Bước đã có kết quả hoàn tất được lưu không tự chạy lại. Tool có tác động
bên ngoài nhưng chưa lưu được kết quả phải có idempotency/reconciliation
hoặc recovery decision tường minh; không suy ra exactly-once từ checkpoint.

Backend plugin chỉ thực hiện lưu/đọc và consistency primitives theo core
contract. Phục hồi qua restart cần backend lưu bền vững. Lifecycle đã chốt:
suspend kết thúc lượt tiêu thụ events, resume cùng streamId bằng handle mới.
Checkpoint schema, interrupt/resume signatures và plugin/resource lifecycle
qua suspension vẫn cần review trước implementation.

### 3.1.2. Đổi model tại resume boundary

Đã chốt: checkpoint/trace ghi provider/model đã dùng để giữ lịch sử chính
xác, không khóa model cho lời gọi tương lai. Resume mặc định giữ selection
trước đó; dev có thể chỉ định model khác tường minh. Core resolve selection
đó qua model registry và validate request mới tại boundary trước model call.
Việc đổi model không tự thay tool/hook registrations khác của execution.

Messages, tool definitions và provider state/reasoning signatures phải có
request projection hợp lệ cho adapter được chọn. Adapter/context pipeline
xử lý chuyển đổi; lỗi compatibility được báo ở bước chuẩn bị request, không
coi khác model ID tự nó là lý do cấm resume. Tool call đang chờ duyệt vẫn
giữ payload và policy riêng, độc lập với model cho lời gọi tiếp theo.

Không nối phần token đang sinh của attempt cũ sang model mới. Nếu cần thay
model trong khi attempt cũ chưa hoàn tất, kết thúc attempt đó và tạo attempt
mới với trace/usage riêng; không viết lại records của attempt trước.

### 3.2. Scope metadata của state và Session defaults

Scope trong yêu cầu multi-user chỉ áp dụng cho state. Core không xây dựng
một ExecutionScope/DI container riêng cho mỗi user. Agent, loop, plugin
definitions và provider registry có thể được application dùng chung.

Scope là plain-object metadata do application cung cấp, ví dụ userId hoặc
workspaceId. StateScope nếu export chỉ là TypeScript data type, không là
class có lifecycle hoặc constructor. Scope được lưu trong state và sử dụng
làm query filter; không thay identity của thread hoặc tạo một auth boundary.

Session giữ defaults/filters cho các thao tác state. Thread lưu scope metadata
thực tế để có thể load lại từ một Session khác. Model execution records kế
thừa metadata của thread được xử lý. Application sở hữu access control.

Ví dụ API đề xuất:

```ts
const session = new Session({
  agent: sharedAgent,
  scope: { userId, workspaceId },
  model: selectedModel,
});

const threads = await session.listThreads();
const thread = await session.getThread(threadId);
```

Các lifecycle owners như agent/session/thread/stream/turn là chiều riêng với
scope metadata. Plugin state lưu pluginId, ownerType/ownerId và metadata
scope phù hợp; không biến các fields scope thành composite identity bắt buộc.

Session là API tiện dụng cho application; storage ports là contracts để
tác giả storage backend plugin dùng phía sau API này. Plugin cũng có thể dùng
public state APIs tường minh mà không phụ thuộc một Session của host.

### 3.3. Thread operations, fork và subagent extensibility

Session đề xuất cung cấp createThread/getThread/getHistory/listThreads/deleteThread/
forkThread. getHistory đọc canonical message history có phân trang, cũng có
trên Thread; không thay thế bằng snapshot toàn state hoặc execution records.
Get lấy thread hiện có theo filters của Session, không tự tạo
thread nếu không tồn tại. Missing-thread outcome cần được chốt trong API
contract trước implementation.

Fork tạo thread mới tại một boundary history hợp lệ, mặc định kế thừa scope
của Session/parent theo options đã công bố. Giữ parentThreadId và
forkPointMessageId để truy nguồn. Core kiểm tra tool-call/result correlation;
trace/usage của executions cũ không bị tính thành usage mới vì fork.
Plugin-owned state có fork policy riêng.

Subagent là orchestration plugin. Public SDK cho phép plugin tạo thread con
với scope metadata tường minh hoặc kế thừa parent, chạy child stream với
model selection riêng và trả tool result về parent. ParentThreadId và
parentStreamId biểu diễn lineage; không dùng chúng làm scope thay user.
Runtime/registries vẫn có thể dùng chung và model selection của parent
Session không bị thay đổi để chạy child stream.

## 4. Bề mặt SDK đề xuất

Ví dụ dưới đây minh họa cách dùng, chưa phải API đã triển khai:

```ts
const agent = new Agent({
  id: "application-assistant",
  instructions: "Help users find relevant documents.",
  plugins: [new OpenAIPlugin({ apiKey }), searchPlugin({ searchClient })],
});

await agent.initialize();

const session = new Session({
  agent,
  model: selectedModel,
  scope: { userId: "user-123" },
});

const thread = await session.createThread();

const stream = session.stream({
  thread,
  input: new HumanMessage("Find documents about the release process."),
  context: { actorId: "user-123" },
  signal: requestAbortSignal,
});

for await (const event of stream) {
  renderOrForward(event);
}
```

Stream phát typed events; StreamEnd chứa outcome tổng hợp khi execution kết
thúc. StreamSuspended cho biết execution đã lưu state và đang chờ phản hồi;
iterator kết thúc ở mốc này nhưng execution chưa có terminal outcome.
Callback helper có thể được cung cấp cho host. `stream.result` không phải
API nền tảng bắt buộc; helper tổng hợp, nếu thêm, cần phân biệt suspension
với terminal outcome. Buffering/attachment semantics của iterator còn review.

Resume qua cùng API streaming (signatures minh họa, chưa triển khai):

```ts
const resumed = session.stream({
  thread,
  resume: { interruptId, value: userResponse },
});

for await (const event of resumed) {
  renderOrForward(event);
}
```

Resumed handle giữ cùng streamId của logical execution. Host quản lý vòng
đời tài nguyên; kết thúc iterator do suspend không phải yêu cầu hủy execution.

CLI dùng events để cập nhật terminal. Backend dùng cùng events để gửi qua
transport đã chọn. Application có thể tiêu thụ lifecycle events mà không render.
Core không tự đọc stdin, ghi stdout, mở browser hoặc đăng ký process signals.

`stream.abort()` và `signal` cùng dẫn tới một cơ chế cancellation. Cleanup của
thread/agent chờ các stream liên quan kết thúc hoặc hủy chúng trước khi đóng
tài nguyên. Dispose phải idempotent.

Streaming transport, HTTP server, RPC, terminal commands và renderer không
là điều kiện để chạy SDK. Helper tích hợp có thể được thêm ở lớp ngoài core.

### 4.1. Constructor và async lifecycle

Constructor chỉ nhận cấu hình, tạo state ban đầu và kiểm tra những điều kiện
đồng bộ. Constructor không thực hiện I/O, gọi model hoặc khởi chạy một
Promise ngầm mà host không kiểm soát được.

`initialize()` thực hiện plugin setup bất đồng bộ và hoàn tất registry.
Đề xuất dùng bước này tường minh, thay vì tự setup ở lần stream đầu tiên:

- Backend initialize khi startup; lỗi cấu hình được phát hiện trước khi nhận request.
- CLI initialize trước khi bắt đầu vòng nhận input.
- Tests kiểm soát chính xác thời điểm setup và cleanup.

Trạng thái lifecycle:

```text
constructed -> initializing -> ready -> disposing -> disposed
                      |
                      +-> failed -> disposing -> disposed
```

Initialize đồng thời hoặc lặp lại chia sẻ cùng kết quả initialization;
không setup plugin hai lần. Nếu initialization thất bại, rollback tài nguyên
đã tạo và giữ trạng thái failed. Không tự retry trên cùng instance.

`createThread()` chỉ được gọi khi ready và trả Promise để có thể await
thread preparation, bao gồm load initial history từ plugin, trước khi
thread được sử dụng. Thread ID được tạo trước preparation; host chưa nhận
thread chạy được cho tới khi preparation và validation hoàn tất. Preparation
thất bại không để lại một thread sẵn sàng một phần.

Dispose được phép từ constructed,
ready hoặc failed. Nếu dispose được yêu cầu khi đang initializing, chặn
việc nhận thread mới, báo cancellation cho setup và chờ initialization
settle/rollback trước khi cleanup kết thúc. Setup phải tuân thủ signal.

Sau khi disposed, instance không được initialize hoặc chạy lại. Host tạo
instance mới khi cần lifecycle mới. Agent dispose chịu trách nhiệm đóng các
thread nó tạo; thread dispose chỉ đóng thread đó.

### 4.2. Factory chuyên biệt vẫn sử dụng new Agent

Ví dụ minh họa, chưa phải implementation:

```ts
function createCodingAgent(options: CodingAgentOptions): Agent {
  return new Agent({
    id: options.id,
    instructions: options.instructions ?? codingInstructions,
    plugins: [
      new WorkspaceToolsPlugin({ root: options.workspaceRoot }),
      ...options.plugins,
    ],
  });
}

const agent = createCodingAgent({
  id: "coding-assistant",
  workspaceRoot: projectRoot,
  plugins: [new OpenAIPlugin({ apiKey })],
});

await agent.initialize();
```

Factory này trả một Agent chưa initialize, giống như `new Agent(...)`.
Việc initialize vẫn do caller quyết định. Factory không có engine, registry
hoặc loop khác với Agent nền. Instructions, workspace tools và các policy
của coding agent được ghép từ cấu hình và plugins ở ngoài core.

Ứng dụng có thể tự viết `createSupportAgent`, `createResearchAgent` hoặc
factory riêng bằng cùng API. Factory chính thức không có quyền riêng để
truy cập internals của Agent.

Preset phải nói rõ defaults và tập plugins nó thêm. Không âm thầm thêm một
plugin trùng tên hoặc ghi đè plugin do caller truyền vào; xung đột theo cùng
registration rules của core.

### 4.3. Class cho lifecycle, composition cho khả năng

Các đối tượng có lifecycle và state rõ ràng được đề xuất dưới dạng class:
`Agent`, `Thread` và `Stream`. Stream được thread tạo, thread được agent tạo;
caller không tự construct các đối tượng con với state nội bộ tùy ý.

Class API cho phép bổ sung phương thức ở lớp ứng dụng khi cần. Điểm mở rộng
execution được hỗ trợ là plugin contracts và hooks, thay vì override nội bộ
agent loop. Những thuộc tính giữ canonical state và registry được encapsulate.

Không yêu cầu tạo subclass CodingAgent chỉ để thêm file tools và instructions.
Factory ghép plugin là đủ cho trường hợp đó. Một subclass, nếu có lý do tồn
tại, vẫn dùng cùng core execution và public contracts.

Plugin implementation có thể là class giữ dependencies và tài nguyên của nó.
Đề xuất contract Plugin là interface có kiểu với setup/dispose semantics,
để class hoặc object thỏa interface đều dùng được. Việc bắt buộc mọi plugin
phải kế thừa một base class vẫn là lựa chọn cần người dùng xác nhận.

## 5. Model contract

Core gọi ModelAdapter contract thống nhất. Providers được đăng ký qua plugin
API; SDK cung cấp ModelProvider contract và các adapters/helpers như
OpenAIProvider, AnthropicProvider hoặc GoogleProvider để tác giả plugin dùng.
Các helpers không tự đăng ký, lựa chọn model hoặc gắn behavior vào core.

Model implementations chịu trách nhiệm HTTP, authentication, parsing và
chuyển đổi messages sang giao thức provider. Có thể tận dụng SDK chính thức
bên trong implementation khi phù hợp. Agent loop, state, event và usage
semantics vẫn do core Tessar sở hữu.

Model registry hỗ trợ provider registration để resolve model ID theo provider
và single-model registration cho adapter đặc biệt. SDK tự resolve model metadata
qua catalog/API thích hợp và expose qua model.profile; không bắt dev tự điền
profile/capabilities. Host/plugin đọc cùng metadata để làm model picker hoặc
kiểm tra request. Core không hardcode danh sách models của từng hãng;
metadata resolution thuộc SDK provider helpers/adapters. Helper modules
được import tường minh và có thể dùng
SDK chính thức bên trong implementation. Package exports vẫn cần được chốt
trong kế hoạch implementation.

Ví dụ tự viết plugin bằng helper SDK:

```ts
class OpenAIPlugin implements Plugin {
  readonly id = "provider.openai";

  constructor(private readonly options: OpenAIProviderOptions) {}

  setup(api: PluginContext) {
    api.models.register(new OpenAIProvider(this.options));
  }
}
```

Model selection truyền vào Stream đến từ host Session hoặc lựa chọn tường
minh của backend call. Core resolve selection qua cùng registry dù provider được ship cùng
CLI hay load từ ngoài. Attempt trace ghi provider/model thực sự được gọi;
không lấy current selection mới của Session để sửa lịch sử attempts cũ.

Registration thêm sau initialization cần prepare/setup và publish một
registry generation nguyên tử. Stream giữ generation/bindings đã chụp;
plugin setup thất bại không làm hỏng các registrations đang dùng. Host
đóng gói chịu trách nhiệm loader và compatibility. Detach ngừng cấp bindings
cho Streams mới, giữ bindings và tài nguyên cho executions đang dùng chúng
đến khi kết thúc; xem quy tắc lifecycle ở mục 8.

Request của model bao gồm:

- Instructions và messages của context hiện tại.
- Các tool definitions đang khả dụng.
- Model options và cancellation signal.

Stream model cần biểu diễn các phần text mới, các phần reasoning mới nếu có, tool-call
assembly, usage nếu có và kết thúc lượt model. Provider không cung cấp
reasoning hoặc usage thì không tạo dữ liệu giả cho những trường đó.

Core chuẩn hóa tool calls hoàn chỉnh trước khi thực thi. Tool arguments còn
đang stream không được đưa vào tool executor. Tool call IDs phải duy nhất
trong phạm vi tương ứng và được giữ để nối request với result.

Provider-specific options đi qua cấu hình adapter riêng, không làm core
phụ thuộc danh sách options của từng hãng. Khả năng hỗ trợ tool calls hoặc
các dạng content cần được kiểm tra; adapter không âm thầm bỏ dữ liệu mà nó
không hỗ trợ.

Core không tự chọn provider, tìm credentials hoặc gọi lại request bị lỗi.
Application cấu hình provider và credentials; chính sách retry là phần mở
rộng riêng, phải xét cả cancellation và tính an toàn khi thực thi lại.

### 5.1. model.profile và tự động lấy metadata

Yêu cầu đã chốt: khi lấy/chọn model, dev đọc model.profile để có thông tin
model; không phải khai báo ModelProfile thủ công. ModelProfile là public
data contract cho thông tin SDK resolve, không phải prerequisite constructor
mà application phải tự điền mới dùng được model.

```ts
// API minh họa, chưa triển khai; resolver/loading signatures còn review.
const model = agent.models.get(modelId);

model.profile.contextWindow;
model.profile.maxOutputTokens;
model.profile.capabilities;
model.profile.pricing;
```

Core định nghĩa profile contract và normalized/validated representation.
SDK cung cấp metadata resolvers qua provider helpers/adapters, lấy thông tin
từ catalog hoặc API metadata phù hợp; provider plugin dùng helpers không
phải buộc application/tác giả plugin duy trì profile cho từng model. Plugin
registration và transport integration giữ nguyên ranh giới đã chốt.

Profile là metadata của model, không phải endpoint/authentication profile
hay request options như temperature. Profile có thể chứa model identity,
display name, context/output limits, capabilities/modalities và pricing
khi có nguồn. Fields thiếu phải giữ trạng thái chưa biết, không suy ra
false/0 hoặc bắt dev nhập tay cho model custom/chưa có metadata.

Không hứa có mọi field cho mọi model. Nguồn dữ liệu cụ thể, mapping provider/
model identity, thời điểm resolve, cache/refresh/freshness và biểu diễn
partial/unavailable cần review trước implementation. Resolution phải làm
cho dữ liệu đọc qua model.profile nhất quán giữa host, engine và plugins.

## 6. Message và tool contracts

Messages gồm roles và content có cấu trúc, giữ được text, tool calls và tool
results. Thiết kế không ép mọi dữ liệu thành một chuỗi text. Các loại content
khác như image cần một contract và capability check rõ ràng trước khi được
coi là hỗ trợ.

### 6.1. Public message primitives

SDK cung cấp constructors nền tảng, không yêu cầu application tạo payload
provider-specific hoặc import message types từ framework khác:

| Class đề xuất | Role | Ý nghĩa |
| --- | --- | --- |
| SystemMessage | system | Instructions trong message context |
| HumanMessage | user | Input của người dùng |
| AssistantMessage | assistant | Nội dung do agent trả về, bao gồm tool calls khi có |
| ToolMessage | tool | Kết quả được nối với một tool call |

Các class dùng chung Message contract, giữ ID, role, content có cấu trúc và
metadata được công bố. Constructors normalize string content thành text
content, kiểm tra dữ liệu đồng bộ và không thực hiện I/O. ToolMessage cần
tool-call identity; core tiếp tục kiểm tra correlation với history.

Ví dụ API đề xuất:

```ts
const thread = await agent.createThread({
  messages: [new SystemMessage("Help users find relevant documents.")],
});

const stream = thread.stream({
  model: selectedModel,
  input: new HumanMessage("Find documents about the release process."),
});

const exampleReply = new AssistantMessage("Here are the relevant documents.");
const exampleToolResult = new ToolMessage({
  toolCallId: "call-1",
  content: "Found two documents.",
});
```

Class instances là bề mặt SDK; storage và transports dùng MessageData DTO
có discriminator và schema version. MessageCodec encode/decode để validate
và khôi phục message instances đúng loại, giữ nguyên IDs. Không lưu class
instances hoặc dựa vào JSON.parse tự khôi phục prototype.

SDK có thể nhận string input như một shortcut chuyển thành HumanMessage.
Structured messages vẫn là contract chung của model/tool/event pipeline.
Custom plugin metadata có namespace; không tùy ý thêm role mới mà adapters
không biết biểu diễn.

Reasoning/thinking thuộc AssistantMessage content parts, không tạo thêm
message role. Parts giữ thứ tự và identity; provider state/signatures có thể
gắn tại part hoặc message theo adapter protocol. MessageDelta có message/part
identity và part kind để host phân biệt reasoning với text. Visible summary
không là nguồn để suy ra actual reasoning token usage.

MessageCodec round-trip được provider state. Context transforms và model
switching đi qua adapter compatibility checks cho các parts cần bảo toàn;
không coi signatures như text có thể tự sửa hoặc flatten vào prompt.

### 6.2. Tool class và createTool helper

Tool definition gồm tên, mô tả, input schema, input validator và execute.
Schema gửi cho model phải khớp validator được dùng trước khi thực thi;
public API không bắt người viết plugin sử dụng một thư viện schema cụ thể.

Đề xuất cung cấp Tool class và createTool helper dùng cùng contract.
`createTool(...)` trả một Tool, hỗ trợ type inference cho input/output và
giảm boilerplate; không có một executor hoặc tool registry riêng.

Input definition liên kết model-facing schema với runtime parser/validator
và TypeScript input type. SDK helper không thể suy ra kiểu đáng tin cậy chỉ
từ một callback khai báo tùy ý. Adapters cho schema libraries là các helpers
riêng; không bắt core phụ thuộc một thư viện cụ thể.

Ví dụ đề xuất:

```ts
const searchTool = createTool({
  name: "search_documents",
  description: "Find relevant documents.",
  input: searchInput,
  async execute(input, context) {
    return searchDocuments(input.query, { signal: context.signal });
  },
});

class SearchPlugin implements Plugin {
  readonly id = "search";

  setup(api: PluginContext) {
    api.tools.register(searchTool);
  }
}
```

`searchInput` và `searchDocuments` là dependencies của ví dụ; executor cần
trả ToolResult theo cùng content/metadata contract ở phần dưới. Helper hỗ
trợ inference không có nghĩa arbitrary raw output tự động hợp lệ cho model.

Tool execution context cung cấp stream/thread IDs, request context, signal và
cách phát progress/output. Tool không có quyền sửa trực tiếp canonical
message history hoặc nội bộ state machine.

Tool result tách content dành cho model khỏi metadata dành cho host khi cần.
Ví dụ một search tool có thể gửi đoạn văn bản liên quan cho model và gửi
thông tin dùng để render citation cho ứng dụng. Metadata không tự động trở
thành prompt content.

Giai đoạn đầu thực thi tool calls tuần tự để thứ tự hooks và tác động rõ
ràng. Parallel tools là mở rộng sau khi có semantics cho ordering,
cancellation và policy; không chỉ là thay vòng lặp bằng Promise.all.

Tool không tồn tại, arguments không hợp lệ hoặc tool execution failure tạo
tool error result để model có thể xử lý. Những lỗi này khác lỗi engine hoặc
provider không được recovery xử lý, vốn làm stream failed.

## 7. Agent loop và tính nhất quán

Luồng mỗi stream:

1. Kiểm tra thread sẵn sàng, nhận input và chạy input/stream preparation.
2. Nếu input được plugin xử lý, kết thúc với handled outcome hợp lệ. Nếu
   input bị từ chối, không commit input đó.
3. Với input được chấp nhận, chạy message pipeline và commit input.
4. Bắt đầu turn; chọn tools/model, chuẩn bị context và normalized request.
5. Gọi model binding và phát streaming events. Recovery decision có thể
   yêu cầu retry một attempt chưa commit, trong attempt budget.
6. Hoàn tất response; chạy message transforms, validation, commit barrier
   rồi commit assistant message.
7. Với mỗi tool call: chuẩn bị arguments, validate, chạy policy, execute,
   transform result và đi qua message commit pipeline.
8. Kết thúc turn và áp dụng continuation decision. Tool calls thông thường
   dẫn tới lượt model tiếp; plugin có thể đề xuất dừng hoặc thêm một lượt
   ở boundary hợp lệ. Mọi quyết định chịu cancellation và stream limits.
9. Khi không cần tiếp tục, chạy finalization rồi phát StreamEnd với terminal
   outcome đúng một lần. Nếu execution yêu cầu external input tại boundary
   hợp lệ, core lưu pending request/checkpoint, phát StreamSuspended và kết
   thúc lượt đọc events; resume sau đó tiếp tục cùng streamId bằng handle mới.

Core là nơi duy nhất commit canonical messages. Context hooks thao tác trên
bản request context, không tự ghi đè lịch sử hội thoại. Storage service của
core quản lý lưu dữ liệu trong đường commit qua backend được chọn; không
dựa vào notification observers để tạo tính năng persistence.

Model output đang stream là dữ liệu tạm thời. Nếu model stream hỏng hoặc bị
hủy trước khi lượt model hoàn tất, dữ liệu tạm thời không trở thành một
assistant message hoàn chỉnh trong canonical history. Host có thể giữ phần
hiển thị này với trạng thái lỗi/hủy.

Nếu assistant message với tool calls đã được commit, mọi call phải được
khép lại bằng result hoặc trạng thái lỗi/hủy tương ứng trước khi thread có
thể tiếp tục. Không để lịch sử chứa tool calls treo rồi gửi lượt kế tiếp.

Giới hạn stream gồm số lượt model/tool phù hợp để tránh loop vô hạn. Đạt giới
hạn trả stopped cùng lý do, không giả làm một câu trả lời hoàn chỉnh.

## 8. Plugin contract và lifecycle

Plugin có ID, thông tin compatibility của plugin API và setup method.
Setup nhận API đăng ký có kiểu: model bindings, tools và lifecycle handlers
qua `context.on(...)`. Setup có thể trả disposer cho tài nguyên plugin sở hữu.

Ở bản đầu, application truyền plugin instances trực tiếp cho SDK. Core
không tự quét thư mục, cài npm packages, chạy package manager hoặc tải code
từ mạng. Theo yêu cầu người dùng ngày 2026-10-15, loader/discovery cho host
đã đóng gói, công cụ install/update/remove plugin và quản lý package dependencies
được ghi thành nợ kỹ thuật TD-001 trong
[architecture notes](../../architecture-notes.md), ngoài phạm vi phase này.
Plugin local không bắt buộc thành npm package; application import/khởi tạo
plugin và tự quản lý dependencies bằng công cụ của project. Plugin contracts
và registration/attach/detach semantics vẫn thuộc thiết kế hiện tại.

Lifecycle đề xuất:

1. Kiểm tra IDs, compatibility và cấu hình.
2. Trong `agent.initialize()`, setup plugins theo thứ tự application cung cấp.
3. Hoàn tất registry; agent chuyển sang ready.
4. Tạo thread và thực thi streams.
5. Kết thúc threads/streams; gọi disposers theo thứ tự ngược.

Quy tắc thay đổi plugin khi Agent đang chạy đã chốt ngày 2026-10-15:

- Stream chụp bộ plugin và registrations lúc bắt đầu: providers/model
  bindings, tools và handlers. Các turns tiếp theo vẫn dùng bộ này.
- Attach setup registrations mới trước, rồi publish nguyên tử cho Streams
  bắt đầu sau đó. Setup thất bại rollback phần mới, giữ runtime đang chạy.
- Detach loại registrations khỏi bộ cấp cho Streams mới. Stream đang dùng
  plugin tiếp tục; disposer chỉ chạy sau khi không còn execution giữ tài
  nguyên plugin. Không dispose connection/tool/provider dưới execution.

Đây là snapshot registrations, không phải deep-copy toàn bộ plugin state.
Plugin chịu trách nhiệm quản lý state dùng chung theo contracts công khai.
Tên API attach/detach, dependency handling và cơ chế reload chưa chốt.

Trùng plugin ID, tool name hoặc model binding là lỗi khởi tạo; không âm thầm
ghi đè. Nếu setup lỗi, rollback registrations và cleanup các tài nguyên đã
khởi tạo. Cleanup lỗi vẫn phải tiếp tục đóng các tài nguyên còn lại rồi
báo lỗi có cấu trúc.

Resource do application truyền vào không mặc nhiên thuộc quyền dispose của
plugin. Cách chuyển quyền sở hữu phải được thể hiện rõ trong plugin options.

Plugin registry không được dùng như một service locator tùy ý để truy cập
mọi internals. Plugin giao tiếp qua contracts công khai hoặc composition
tường minh của application. Dependency resolution và sandbox cho plugin
không thuộc phạm vi core đầu tiên đang đề xuất. Attach/detach tuân thủ quy
tắc giữ registrations cho execution đang chạy ở trên. Hot reload/package
loading vẫn cần review riêng; không suy ra hỗ trợ từ quy tắc attach/detach.

Plugin là code chạy trong host process ở thiết kế ban đầu. API nhỏ giúp giảm
coupling, nhưng không tạo một security sandbox cho code không tin cậy.

## 9. Hooks thay đổi hành vi và events quan sát

Event API là một phần chính thức của plugin contract, bên cạnh đăng ký
models và tools. Người sử dụng không cần nhớ hoặc tự gõ event-name strings.
Bề mặt đề xuất là `context.on(eventDefinition, handler)`, ví dụ
`context.on(AgentEvents.MessageDelta, handler)`. Event definitions mang type
của payload, execution context, event kind và handler result; SDK export một
catalog có autocomplete. String identifiers trong event catalog bên dưới
là IDs nội bộ/transport, không phải tên mà consumer phải tự gõ để subscribe.
Các hooks và notification handlers dùng cùng cách đăng ký; dispatcher của
core quyết định semantics theo từng loại event, không dựa vào tên handler
hoặc một return value tùy ý.

Phân biệt hai cơ chế phía sau API này:

- Hooks tham gia vào execution: có thể được await và thay đổi quyết định hoặc
  dữ liệu tại một điểm được định nghĩa.
- Events thông báo diễn biến: phục vụ rendering, tracing và transport; không
  sửa state hoặc thay thế policy decisions.

Ví dụ plugin, chưa phải implementation:

```ts
class PermissionPlugin implements Plugin {
  readonly id = "permissions";

  constructor(private readonly approve: ApprovalHandler) {}

  setup(api: PluginContext) {
    api.on(AgentEvents.BeforeTool, async (event, context) => {
      const allowed = await this.approve(event, context.signal);
      return allowed
        ? { decision: "allow" }
        : { decision: "deny", reason: "User declined" };
    });

    api.on(AgentEvents.StreamEnd, (event) => {
      recordStreamStatus(event);
    });
  }
}
```

`AgentEvents.BeforeTool` là interception point có kết quả quyết định rõ ràng.
`AgentEvents.StreamEnd` là notification với handler trả void. Event definitions
phải phân biệt hai contracts đó; một giá trị trả về từ notification không
được làm thay đổi stream. IDE suy ra event payload/context và decision type từ
definition truyền vào, thay vì bắt người sử dụng tự khai báo generic hoặc
tra một bảng tên string.

Đề xuất dùng typed definitions thay vì chỉ một enum/string constants catalog.
Definitions còn mô tả event kind, payload/result contracts và identity ổn
định. Enum/string constants có thể hỗ trợ autocomplete, nhưng bản thân
constants không biểu diễn đầy đủ semantics của từng event.

Mỗi definition có stable ID và compatibility metadata do owner khai báo.
Dispatcher lookup theo registered ID, không chỉ dựa vào object identity hay
Symbol, để không phụ thuộc một module instance duy nhất. PluginHost kiểm tra
owner/compatibility khi đăng ký; một definition không hợp lệ không được giả
core event. Event IDs vẫn có thể được serialize khi host cần truyền events
qua transport.

### 9.1. Mức độ bao phủ extension points

Catalog dưới đây là đề xuất để review kiến trúc; không đồng nghĩa tất cả
events phải được triển khai cùng một lúc. Mỗi event được triển khai phải có
payload, return type, ordering, cancellation và error contract cụ thể.

| Nhóm | Events đề xuất | Quyền/hành vi |
| --- | --- | --- |
| Agent lifecycle | agent_ready, agent_shutdown | Quan sát ready; chờ flush/cleanup trước teardown |
| SDK Session | SessionEvents.Created/ModelChanged/ThreadCreated/ThreadForked/ThreadDeleted/BeforeClose/Closed | Cùng typed dispatcher, scope và controller/agent/thread/stream context; không cần public Session ID |
| Thread preparation | thread_prepare | Cung cấp initial messages và metadata trước khi thread sẵn sàng |
| Thread lifecycle | thread_start, thread_before_shutdown, thread_shutdown | Mở/đóng tài nguyên, flush state và quan sát kết thúc |
| Thread state | thread_updated | Quan sát một state update đã được core kiểm tra và commit |
| Input | input_prepare | Biến đổi input hoặc xử lý nó bằng plugin mà không cần gọi model |
| Input notification | input_received | Quan sát input đã được chuẩn hóa và chấp nhận |
| Stream preparation | before_stream | Chuẩn bị request-scoped context hoặc từ chối stream trước execution |
| Stream lifecycle | stream_start, stream_before_end, stream_end | Theo dõi, finalization barrier và terminal notification |
| Stream suspension | stream_suspended, stream_resumed | Quan sát checkpointed suspension/resume của cùng execution; exported definitions như AgentEvents.StreamSuspended, không cần ghi nhớ strings |
| Turn lifecycle | turn_start, turn_end | Quan sát một vòng model/tools; phân biệt với toàn bộ stream |
| Continuation | turn_decision | Đề xuất tiếp tục hoặc dừng tại ranh giới lượt; core áp dụng giới hạn |
| Context | context_prepare | Biến đổi instructions/messages trong model context |
| Tool exposure | tools_select | Chọn subset tools đã đăng ký cho lượt model hiện tại |
| Model routing | model_select | Nhận selection đã chụp từ Session/backend call; policy có thể đề xuất binding khác ở boundary hợp lệ |
| Model request | model_request | Biến đổi normalized request trước khi gọi adapter |
| Model lifecycle | model_start, model_end | Quan sát mỗi model attempt |
| Model response | model_response | Biến đổi response hoàn chỉnh trước khi chuyển sang message pipeline |
| Model accounting | model_usage | Quan sát usage mà adapter thực sự cung cấp |
| Model error | model_error | Quan sát lỗi một attempt |
| Model recovery | model_recover | Đề xuất retry có giới hạn hoặc giữ lỗi; không tự thực thi lại tools |
| Message preparation | message_prepare | Biến đổi message trước validation cuối và commit |
| Message commit barrier | message_before_commit | Chờ công việc bắt buộc trước commit, không sửa message đã được validate |
| Message stream | message_delta | Nhận phần nội dung mới của assistant message trong lúc streaming |
| Message notification | message_committed | Quan sát canonical message đã commit |
| Tool arguments | tool_prepare | Biến đổi arguments trước validation và approval |
| Tool policy | before_tool | Quyết định allow/deny đối với tool và arguments cuối cùng |
| Tool execution | tool_start, tool_update, tool_end | Quan sát execution, progress và kết quả |
| Tool errors | tool_error | Quan sát lỗi; vẫn đi qua tool-result pipeline |
| Tool results | tool_result | Biến đổi model-facing content/host metadata trước message commit |
| Cancellation | stream_cancel | Quan sát cancellation được chấp nhận; không được đảo ngược quyết định hủy |

Giữ thuật ngữ delta, đặt public event là `message_delta` vì payload mô tả
phần nội dung mới của assistant message. Delta là phần nội dung mới được gửi
thêm trong lúc streaming. Payload chứa phần nội dung mới
để nối thêm vào output hiện tại, không phải toàn bộ output đã tích lũy.
Payload cần chỉ rõ loại nội dung, ví dụ text hoặc reasoning, và message ID
cùng identity của stream/thread tương ứng. Model attempt có thể là metadata
để nối events với lần gọi model. Các loại output không được nối lẫn vào cùng
một chuỗi. Các events model_request/model_response/model_start/model_end
mô tả giao tiếp và lifecycle của model call, khác với nội dung message.

Ví dụ model lần lượt gửi các phần text “Xin”, “ chào”, “ bạn”. Host nhận ba
message deltas và nối thành “Xin chào bạn”. Khi lượt model hoàn tất,
`model_response` chứa response đầy đủ để đi qua validation và message commit.

Không có plugin thì các điểm transformation giữ nguyên dữ liệu, policy dùng
defaults đã công bố và model/tool bindings được gọi trực tiếp. Core không
tự triển khai memory, compaction, retry policy hoặc orchestration chỉ để
phát một tên event tương ứng.

`agent_ready` được dispatch sau khi mọi setup hoàn tất. Plugin chỉ bắt đầu
nhận events sau khi handlers của nó được đăng ký. Không hứa rằng plugin
nghe được initialize-start của chính nó trước khi setup. Lỗi setup và trạng
thái disposed cuối cùng luôn có đường diagnostics/lifecycle dành cho host.

`stream_before_end`, `thread_before_shutdown` và `agent_shutdown` là các
barrier được await. Notification cuối không có quyền thay đổi kết quả.
Lỗi finalization phải được ghi nhận; cleanup vẫn tiếp tục với các tài nguyên
còn lại. Một stream dự kiến completed có thể thành failed nếu barrier bắt buộc
thất bại, nhưng lỗi hủy/lỗi execution gốc không bị che bởi lỗi cleanup.

Input handler trả kết quả handled phải cung cấp outcome có cấu trúc để core
kết thúc stream hợp lệ; không giả một model response. Input handler từ chối
input không được âm thầm thêm input đó vào canonical history.

Tool selection chỉ chọn những tools đã đăng ký. Model selection chỉ chọn
binding có sẵn. Core kiểm tra capabilities sau khi request transforms hoàn
tất, trước khi gọi model; plugin không được vô tình khai báo tool với model
nhưng để executor không biết tool đó.

Continuation và recovery là typed decisions. Dừng/từ chối có ưu tiên hơn
đề xuất tiếp tục; cancellation và stream limits luôn có ưu tiên cuối cùng.
Retry của một model attempt chỉ diễn ra khi chưa commit response của attempt
đó, nằm trong attempt budget và không replay các tools đã chạy. Không cung
cấp automatic retry cho tool side effects.

Message transformations phải giữ các invariants của role, IDs và tool-call
correlation. Core validate sau các transforms. Message commit barrier không
thể sửa payload sau validation. Barrier không tạo distributed transaction
giữa canonical state và nhiều external stores. Core storage quản lý commit,
failure và recovery theo contract; backend cung cấp I/O/consistency primitives
và công bố limitations. Không suy ra transaction chung chỉ từ một hook.

Trong bảng này, Agent là đối tượng có cấu hình/lifecycle của engine; stream là
một lần execution. Không dùng agent_start/agent_end để gọi tên stream events
nếu điều đó gây nhầm với initialize/dispose của Agent.

Việc subscribe qua `on()` trả unsubscribe function. Registrations được quản
lý theo plugin và Agent sở hữu; mỗi event context mang thread/stream identity
phù hợp để plugin không trộn state giữa hội thoại. Handler list được snapshot
khi dispatch; unsubscribe không sửa một dispatch đang diễn ra. Đăng ký
handlers ở setup, không tự thêm behavior mới vào giữa stream.

Hooks chạy tuần tự theo thứ tự đăng ký. Lỗi ở hook thay đổi hành vi làm stream
failed; không tự bỏ qua một policy bị hỏng. Nếu một policy từ chối execution,
hook sau không được đổi quyết định thành cho phép. Tool nhận result thể hiện
bị từ chối để model biết hành động không xảy ra.

Plugin notification handlers cũng có thứ tự xác định và được await khi trả
Promise. Vì vậy một async handler có thể làm chậm execution, nhất là events
streaming. Lỗi notification được báo qua diagnostics và không biến thành
execution decision. Notification không cung cấp transaction hay cam kết
durability cho việc ghi external storage. State persistence là đường commit
riêng do core storage quản lý; lỗi backend tuân theo failure policy của
framework, không theo error semantics của notification observers.

`onEvent` của host trong stream options là đường quan sát đồng bộ cho UI và
transport, tách khỏi async plugin dispatcher. Hai đường nhận dữ liệu cùng
execution nhưng không có quyền hoặc error semantics giống nhau.

### 9.2. Custom events của plugin và host

Hệ sinh thái cần custom events có namespace để plugin cung cấp lifecycle của
chính nó, ví dụ `memory:recall_start`, `memory:recall_end`,
`context:compact_start`, `context:compact_end` và `subagent:completed`.

Plugin khai báo typed event definitions trước setup; PluginHost thu thập và
kiểm tra declarations trước khi dispatch. Consumer import definition/token
để subscribe và nhận type inference cho payload/result. Notification hay
interception được xác định trong definition, không suy ra từ event name.

Plugin export catalog riêng, ví dụ `MemoryEvents.RecallStart` và
`MemoryEvents.RecallEnd`. Consumer viết
`api.on(MemoryEvents.RecallEnd, handler)`; chỉ owner khai báo namespace/ID
một lần trong event definition. Plugin tự khai báo events được, không phải
sửa enum hoặc type map trung tâm của core để thêm event riêng.

Chỉ owner của namespace được emit event tương ứng. Plugin khác có thể
subscribe qua public event definition. Core lifecycle event names là reserved;
plugin không được phát giả stream_end, message_committed hoặc before_tool.
Custom interception dùng cùng dispatcher rules và có một owner chịu trách
nhiệm áp dụng result, nhưng không được bỏ qua invariants của core.

CLI host có thể cung cấp namespace cho commands/rendering; backend host có
thể cung cấp integrations của ứng dụng. Những events này được định nghĩa
bởi host integration, không bắt buộc một terminal hoặc HTTP server vào core.

### 9.3. Public commands và implementation contracts

Plugin cần những operations công khai để hành động theo events, bên cạnh
khả năng trả transformation/decision:

- Đọc snapshot của thread, kèm revision và immutable messages.
- Yêu cầu cập nhật thread messages tại thời điểm idle hoặc ranh giới stream
  được core kiểm soát, kèm expected revision. Core validate role/correlation,
  tránh lost updates và phát thread_updated sau khi commit.
- Gửi input cho stream/thread kế tiếp qua cùng admission rules; không tự tạo
  một stream lồng trong thread đang bận.
- Yêu cầu cancellation và đọc trạng thái; chỉ continuation decision ở đúng
  boundary mới được kéo dài stream.
- Tạo child agents/threads bằng public SDK để xây orchestration plugin.

Thread update thay đổi canonical state là một operation rõ ràng, không phải
tác dụng phụ của context_prepare. Context compaction chỉ cho request hiện
tại có thể dùng transformation; compaction muốn lưu state mới phải dùng
operation cập nhật state hợp lệ.

Đọc messages hoặc mutation requests không cho phép sửa trực tiếp references
trong core. Namespace/access của các commands và deadlock restrictions phải
được ghi trong contract khi triển khai. Handler không được await một command
đang chờ chính stream/handler đó hoàn tất.

Khả năng thay implementation được cung cấp qua model/tool bindings. Một
remote tool executor là implementation của tool contract; cache/routing của
model có thể là adapter wrapper dùng cùng contract. Nếu có decorator API,
nó được compose ở setup, trước khi freeze registry và bên trong policy/
validation boundaries của core. Không dùng một notification event để âm
thầm thay executor sau approval.

### 9.4. Kiểm tra triết lý bằng plugin cụ thể

| Plugin | Extension points cần thiết |
| --- | --- |
| Input command | input_prepare, handled outcome và host command definitions |
| Memory/RAG | before_stream/context_prepare, tool registration và custom memory events |
| Permissions | tool_prepare đã hoàn tất, before_tool và host approval callback |
| Model router | model_select, normalized request/capability checks |
| Retry | model_error, model_recover và giới hạn attempts |
| Storage backend | Public backend ports của core storage; I/O và consistency primitives, không ghép persistence bằng observers |
| Compaction | context_prepare, public state update operation và custom compaction events |
| Telemetry exporter | Core execution records, stream/turn/model/tool lifecycle và model_usage |
| Plan/workflow | input/context/tools selection, turn_decision và custom workflow events |
| Subagents | Tool contract, public SDK, cancellation và custom child-agent events |
| CLI integration | Public stream events và host-specific commands/rendering |

Một plugin trong bảng cần thay đổi code nội bộ của loop mới hoạt động là dấu
hiệu thiếu contract. Giải pháp là bổ sung đúng extension point/operation,
giữ tính năng chuyên biệt trong plugin và kiểm tra interaction semantics.

Hook cần tương tác với người dùng phải thông qua host callback được inject
vào plugin. CLI callback có thể mở prompt; application callback có thể chờ
UI hoặc dịch vụ của nó. Callback phải theo cancellation signal. Core không
biết popup, terminal hay HTTP endpoint cụ thể.

Callback trong process có thể dùng cho tương tác tức thời. Durable HITL
dùng suspend/resume có sẵn của core: lưu pending request và checkpoint,
rồi tiếp tục từ phản hồi đã validate/correlate. Plugin chọn khi nào hỏi,
host chọn cách hiển thị/nhận phản hồi. Không dựa vào một Promise đang chờ
để phục hồi qua restart; cần backend lưu bền vững và recovery contract.

## 10. Events, errors và cancellation

Events có cấu trúc, stream/thread IDs và thứ tự xác định. Các nhóm cần có:

- Stream started và một terminal event: completed, cancelled, failed hoặc stopped.
- Suspend/resume và pending external-input requests. StreamSuspended kết
  thúc lượt đọc events, chưa là terminal outcome. Resume trả handle mới và
  tiếp tục cùng streamId; StreamEnd chỉ phát khi logical execution kết thúc.
- Message deltas và committed messages.
- Tool requested, started, progress và finished.

Host observer callback, nếu dùng, là đồng bộ, không await nó như một policy
hook. Callback lỗi không được âm thầm biến thành permission decision hoặc
làm hỏng agent loop; có đường diagnostics riêng cho host.

Application hoặc transport adapter chịu trách nhiệm queue và backpressure
khi chuyển events ra network. Buffering và cách tiêu thụ events vẫn cần
hoàn thiện contract. Quy tắc đã chốt: ngừng đọc events hoặc client disconnect
không mặc nhiên hủy execution. Host quyết định có truyền tín hiệu hủy xuống
Stream hay tiếp tục chạy; SDK không tự gắn transport disconnect với abort.

Các lỗi phải phân biệt: cấu hình/registration, thread busy, model/provider,
tool error, plugin hook và cancellation. Stream result gồm status, lý do kết
thúc, committed output, usage khi có và lỗi có cấu trúc khi thất bại.

Hủy qua AbortSignal truyền tới model, tools và hooks đang chờ. Core dừng lên lịch
công việc mới, khép lại state hiện tại và phát terminal event. Cancellation
không hoàn tác tác động đã xảy ra và không thể ép một tool JavaScript bỏ
qua signal phải dừng; plugin phải tuân thủ contract cancellation.

## 11. Những khả năng ở ngoài core

| Khả năng | Nơi cung cấp |
| --- | --- |
| Provider protocol và authentication | Provider plugin dùng model SDK helpers hoặc custom adapter; credentials do host cấp |
| Filesystem, shell, search, browser | Tool plugins |
| Chọn nơi lưu dữ liệu | Storage backend plugin; chức năng lưu/khôi phục hội thoại và checkpoint có sẵn trong core |
| Long-term memory, retrieval | Memory/retrieval plugins |
| Skills, project instructions, compaction | Context plugins |
| Tool permissions và approvals | Policy plugin + host interaction |
| MCP | Integration plugin |
| Subagents và workflows | Orchestration plugins sử dụng public SDK |
| CLI commands, themes, keybindings | CLI host/integration |
| HTTP, SSE, WebSocket, RPC | Application hoặc transport integration |

Một capability được liệt kê ở đây không có nghĩa phải xây tất cả ngay ở bản
đầu. Chỉ thêm plugin đầu tiên cần thiết để chứng minh SDK và plugin API.

## 12. Runtime target và backend integration

Mục tiêu đã xác nhận là CLI và backend tự tích hợp. Đề xuất runtime cho bản
đầu là Node.js cho CLI và backend application;
giữ contracts và loop không phụ thuộc terminal, đồng thời tránh Node-only
imports trong kernel khi không cần thiết.

Backend sở hữu HTTP routes, authentication, thread access control,
transport và process lifecycle. Một Agent có thể được initialize khi server
startup, sau đó tạo threads riêng theo hội thoại. Host quyết định vòng đời
thread và storage backend; không ánh xạ mọi người dùng vào một thread chung.

Browser/edge chưa thuộc phạm vi đã xác nhận. Thiết kế headless không tự
chứng minh tương thích các runtime đó; cần đánh giá và kiểm chứng riêng.

## 13. Phạm vi và tiêu chí kiểm chứng bản đầu

Phạm vi đề xuất: một core độc lập, public SDK, plugin contract, model SDK
helpers và provider plugin, một tool plugin đơn giản và hai ví dụ dùng cùng API: CLI nhỏ và
application headless. Renderer lớn, plugin marketplace và việc chuyển Cube
không nằm trong cùng mốc xây core.

Tiêu chí kiểm chứng thiết kế:

- Text-only agent chạy được với chỉ một model binding.
- SDK tự resolve metadata cho model.profile; application không phải tự khai
  báo ModelProfile. Metadata thiếu được biểu diễn rõ, không tạo thông số giả.
- Provider plugin dùng SDK helpers và custom provider plugin cùng đăng ký
  qua public contracts; Session model selection không ghi đè thread state
  hoặc model binding của stream đang hoạt động.
- `new Agent(...)` không thực hiện setup ngầm; initialization và disposal có
  lifecycle xác định, bao gồm setup thất bại và initialize đồng thời.
- Một factory chuyên biệt trả cùng Agent nền; plugins của factory có thể
  được ghép thủ công với new Agent và không cần một engine riêng.
- Tool call được validate, thực thi và nối result đúng trước lượt model tiếp.
- Một plugin custom viết bên ngoài core dùng được trong cả hai ví dụ.
- Plugin đăng ký lifecycle handlers qua cùng typed event API; notification
  và interception có return types, ordering và error semantics phân biệt.
- Subscribe core/custom events qua definitions có autocomplete; handler
  payload/context/result được infer, không yêu cầu nhớ tên strings. Custom
  events không cần sửa một catalog hoặc enum trung tâm của core.
- Event catalog được kiểm tra bằng plugin scenarios: input handling, routing,
  permissions, persistence, compaction, retry và continuation; plugin/host
  custom events không giả core events hoặc bypass state invariants.
- Các threads không dùng chung messages; busy và dispose có hành vi xác định.
- Model stream lỗi, tool lỗi, policy từ chối và cancellation kết thúc đúng state.
- Core không phụ thuộc Cube/Mastra hoặc yêu cầu terminal/process-global setup.
- Một scripted model kiểm chứng loop được mà không cần mạng; model adapters
  có kiểm chứng giao thức riêng và smoke test trực tiếp khi có credentials.

Đây là tiêu chí cho kế hoạch implementation sau khi thiết kế được duyệt,
không phải báo cáo tests đã chạy.

## 14. Bộ API dành cho người tự viết plugin

Đây là đề xuất developer surface để review. Các tên helpers chưa phải cam
kết phát hành; contracts cần nhất quán với state, lifecycle và event semantics
ở trên. Không bắt buộc biến mọi helper thành một subsystem của core.

| Nhóm | Primitives/contracts đề xuất | Dev dùng để |
| --- | --- | --- |
| Plugin lifecycle | Plugin, PluginContext, setup/disposer | Khai báo plugin, đăng ký capabilities và quản lý tài nguyên |
| Messages | Message, HumanMessage, SystemMessage, AssistantMessage, ToolMessage | Tạo dữ liệu hội thoại bằng API chung |
| Tools | Tool, createTool, InputDefinition, ToolResult, ToolExecutionContext | Tạo tool có validation, typed input và cancellation |
| Models | ModelProvider, ModelAdapter, provider SDK helpers, model.profile/ModelProfile, ModelRequest, ModelResponse, ModelStreamEvent, ModelCapabilities | Viết provider plugins bằng helpers sẵn có, tự lấy metadata và đọc profile qua public SDK |
| Events | AgentEvents và typed custom event definitions | Subscribe, khai báo và phát plugin-owned events |
| SDK Session events | SessionEvents và execution/state context | Quan sát lifecycle/selection/operations của Session, không ép public Session ID |
| Instructions | Instruction, InstructionSection, buildInstruction | Ghép sections bất biến, Agent base + Thread additions + explicit plugin transforms |
| Context | ModelContext, StreamContext và context preparation contract | Inject context và dùng request metadata có phạm vi rõ ràng |
| Execution records | StreamRecord, TurnRecord, ModelAttemptRecord, ToolExecutionRecord, UsageSummary | Đọc execution history và token/cache usage từ core |
| State | Scope metadata data type, ThreadSnapshot, MessageData, MessageCodec, checkpoint contracts, ThreadStore, ExecutionStore | Dùng storage/state APIs có sẵn; triển khai backend lưu dữ liệu qua public ports |
| Host integration | Typed host capability definitions, callbacks và suspend/resume contracts | Tích hợp approvals/external input qua core lifecycle mà không phụ thuộc terminal |
| Errors/diagnostics | Các error types và diagnostic sink | Phân biệt configuration, provider, tool, plugin và cancellation failures |
| Configuration | Typed plugin options và validation helpers | Kiểm tra config trước khi plugin được sử dụng |
| Testing | Scripted model adapter, event capture và plugin fixtures | Kiểm thử plugin không cần gọi model thật |

Core sở hữu các contracts, invariants và execution. SDK cung cấp constructors
và helpers trên cùng contracts. Schema-library adapters và test helpers có
thể nằm ở module/package riêng, tránh kéo dependencies không cần thiết vào
ứng dụng chỉ sử dụng core.

PluginContext phải làm rõ phần nào có thể đăng ký tại setup và phần nào dùng
khi runtime: registries/event subscriptions cho registration; thread/stream
contexts cho state/control và request identity. Các operations nhạy với
lifecycle không được dùng tại mọi thời điểm chỉ vì context có tham chiếu.

Plugin state có phạm vi và namespace rõ ràng; tài nguyên có ownership và
cleanup tường minh. Một cache dùng chung cấp agent không mặc nhiên là state
hội thoại, và actor identity không mặc nhiên trở thành authorization check.
Host sở hữu thread access control của application.

Scope metadata không tạo một instance Agent/plugin runtime riêng cho từng
người dùng. Lifecycle owner và query filters được mô tả riêng trong state
APIs; storage adapters thực hiện filter/index theo contract đã công bố.

Mọi symbols tác giả plugin cần sử dụng phải được export qua public SDK hoặc
public contracts entrypoint. Không yêu cầu import đường dẫn src/internal.
Compatibility được kiểm tra theo plugin API version; tài liệu gồm ví dụ
plugin độc lập sử dụng duy nhất các exports này.

Test kit là công cụ phát triển. Nó không trở thành dependency bắt buộc khi
chạy Agent, cũng không được tạo một engine riêng khác semantics của core.

## 15. Các quyết định còn cần review trước implementation

Các định hướng trong notes đã được đồng bộ vào bản nháp. Các mục dưới đây
là lựa chọn chưa duyệt, cần chốt theo mức ảnh hưởng tới contracts:

Giải pháp cụ thể cho từng mục hiện có trong
[bản public API/state machine](2026-10-15-tessar-public-api-state-machine-design.md),
đang chờ review. Đọc bảng này như checklist review bản contract, không phải
yêu cầu mở thêm một vòng brainstorm cho từng tên method hoặc default.

| Quyết định | Đề xuất hiện tại |
| --- | --- |
| Stream consumption | Đã chốt suspend kết thúc lượt đọc events, resume cùng streamId bằng handle mới; consumer disconnect không mặc nhiên hủy execution. Cần chốt buffering; callback/result helpers không bắt buộc |
| Resume compatibility | Đã chốt đổi model tường minh tại resume boundary; mặc định giữ selection cũ, validate request mới và giữ nguyên attempt history. Còn chốt plugin/version/resource lifecycle và capability không còn khả dụng |
| Model metadata resolution | Đã chốt SDK tự lấy thông tin qua model.profile, không bắt dev điền. Còn chọn nguồn catalog/API, identity mapping, loading/cache/refresh và partial/unavailable semantics |
| Scope filters và API outcomes | Plain scalar fields, exact equality kết hợp AND; Session áp dụng defaults. Chốt merge/override tường minh và getThread trả null khi không tìm thấy |
| Fork representation | Snapshot history độc lập với lineage references; fork boundary giữ tool-call/result và provider-state invariants. Plugin-owned state có policy riêng |
| Storage failure và recovery | Checkpoint, suspend/resume và recovery tại boundary có sẵn trong core; plugin chỉ chọn backend. Cần chốt schema, interrupt/resume, ownership và failure policy; không replay tool side effects chưa xác định qua restart |
| Turn/tool scheduling và limits | Đã chốt một Stream mỗi Thread, các Threads chạy đồng thời và hủy qua AbortSignal. Còn review tool calls tuần tự ở bản đầu, turns/attempts budgets và contract thực thi tools song song |

Các chi tiết encoding/schema-library adapters, package exports và error
type names có thể được hoàn thiện trong thiết kế signatures/implementation
plan khi không làm thay đổi các lựa chọn đã thống nhất. Loader/package
distribution và compatibility cho CLI đã đóng gói thuộc nợ kỹ thuật TD-001,
hoãn sang phase sau. Không dùng khoản nợ đó làm điều kiện chặn phase nhận
plugin instances trực tiếp; không tuyên bố CLI binary đã có installer/loader.
