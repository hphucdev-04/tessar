# Tessar — Agent level: bản thiết kế để review

Ngày: 2026-10-17.

Trạng thái: **Agent và OpenAIProvider đã được triển khai trong workspace** theo
các quyết định đã chốt. Tài liệu vẫn giữ những câu hỏi dành cho giai đoạn
Controller/Session. Các ví dụ Anthropic là thiết kế cho adapter tương lai;
package Anthropic/Google chưa được triển khai. Thay đổi này chưa publish npm.

Phạm vi là Agent, model và cách thực thi trực tiếp. Controller/Session chỉ
được nhắc đến ở ranh giới để bảo đảm dev có thể xây tiếp từ Agent.

## 1. Mục tiêu và nguyên tắc nền tảng

Agent là điểm bắt đầu để dev xây một agent CLI hoặc agent tích hợp trong
application. Dev xây tới đâu dùng được tới đó: tạo Agent có model là đã đủ
để thực thi một loop, không phải thiết kế Controller trước.

Các nguyên tắc đã thống nhất trong cuộc trao đổi:

- `Agent` thuộc `@tessar/core`, trực tiếp sở hữu agent loop.
- Dev tự định danh Agent bằng `id`.
- Field `model` trong constructor Agent là **bắt buộc**. Model này có đủ khả
  năng thực thi, thay vì chỉ giữ `providerId`/`modelId` rồi bắt dev đăng ký
  provider riêng ở một nơi khác.
- Model có thể được khai báo inline hoặc tách thành một const; hai cách có
  cùng hành vi.
- Dùng model trực tiếp không bắt buộc phải có provider plugin hoặc Controller.
- Agent chạy trực tiếp không yêu cầu dev gọi `initialize()` hay `dispose()`.
  Mỗi execution tự chuẩn bị và dọn tài nguyên nội bộ theo vòng đời lượt gọi.
- `stream()` và `generate()` dùng chung loop và cùng cách chọn model/options.
- Model trong options của `stream()`/`generate()` chỉ là override cho lượt
  gọi; không thay thế yêu cầu Agent phải có model mặc định ngay khi tạo.
- Message là tham số đầu; options của lượt gọi là tham số thứ hai.
- Thay đổi ở một lượt gọi giữ nguyên cấu hình mặc định của Agent/model.
- Options ghi đè theo từng field cấp cao nhất; object lồng nhau được thay
  nguyên giá trị, không deep merge.
- Chuỗi model ID trong một lượt chỉ đổi model trên kết nối mặc định. Đổi
  endpoint hoặc provider phải chọn một instance mang kết nối tương ứng.
- Tessar giữ nguyên các cấu hình dev đã khai báo, không tự điền thêm mặc định
  cho những field cấu hình model mà dev bỏ trống.
- `maxRetries` và `timeout` đặt ở model/provider. Retry dùng cơ chế của SDK
  cho request provider đủ điều kiện, không tự retry toàn bộ Agent loop.
  Không khai báo thì Tessar không chèn các field này vào cấu hình gửi SDK.

"Anything are plugin" vẫn là định hướng mở rộng. Nó không bắt dev bọc model
hay tool đã có sẵn trong ứng dụng thành plugin để có thể chạy Agent.

## 2. Ví dụ cơ bản: Agent chạy độc lập

```ts
import { Agent } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: "https://api.openai.com/v1",
    model: "gpt-6.1-sol",
    reasoning: { effort: "high" },
    max_output_tokens: 8192,
  }),
});

const stream = agent.stream("Xin chào");

for await (const event of stream) {
  console.log(event);
}
```

Agent thực thi bằng model đã truyền vào. Dev không phải đăng ký thêm một
`OpenAIPlugin` hoặc một danh sách `providers` để đoạn code này chạy.

`OpenAIProvider` đã được export từ source của `@tessar/openai`.
`OpenAIAdapter` và `OpenAIPlugin` được giữ để tương thích với tích hợp cũ.
Ví dụ này dùng API mới trong workspace, chưa phải phiên bản npm đã release.
Các model ID trong ví dụ không phải cam kết về quyền truy cập tài khoản.

### Tách model thành const khi cần tái sử dụng

```ts
const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-6.1-sol",
  reasoning: { effort: "high" },
});

const agent = new Agent({
  id: "assistant",
  model,
});
```

Dev không cần thêm bước `new OpenAIProvider(...).model(...)`. Instance truyền
vào `Agent.model` đã mang theo kết nối và cấu hình cho một model cụ thể.

## 3. Trách nhiệm của Agent và provider

| Thành phần | Trách nhiệm |
| --- | --- |
| Agent | Nhận input, dựng context của lượt, chạy loop, điều phối tools, phát events và tổng hợp kết quả/usage |
| Provider instance | Giữ cấu hình kết nối và model; chuyển request/response/stream giữa Tessar và protocol của provider |
| SDK chính thức của provider | Thực hiện giao tiếp API và hành vi mặc định của SDK |
| Model profile | Cung cấp thông tin model, chẳng hạn context window, capabilities và pricing khi có dữ liệu |

Provider tích hợp dùng SDK chính thức khi có SDK phù hợp. `@tessar/openai`
không tự viết lại toàn bộ OpenAI HTTP client.

Core định nghĩa hợp đồng chung để Agent thực thi model. Code riêng của
OpenAI, Anthropic hoặc Google nằm trong package tích hợp tương ứng; không
đưa cả ba SDK thành dependency bắt buộc của core.

Các instance thuộc provider khác nhau phải thực thi được qua cùng hợp đồng
model. Agent không chứa nhánh xử lý riêng theo tên provider.

## 4. Các field của constructor provider

Ví dụ cấu hình kết nối và tham số request cùng cấp trong constructor:

```ts
const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_BASE_URL,
  defaultHeaders: {
    "X-App-Name": "my-app",
  },

  model: "gpt-6.1-sol",
  reasoning: {
    effort: "high",
    summary: "auto",
  },
  max_output_tokens: 8192,
  parallel_tool_calls: true,
});
```

| Nhóm | Ví dụ | Cách sử dụng |
| --- | --- | --- |
| Kết nối/client | `apiKey`, `baseURL`, `defaultHeaders`, `maxRetries`, `timeout` | Cấu hình SDK/client; không gửi nguyên các field này vào request body |
| Cấu hình model/request | `model`, `temperature`, `top_p`, `reasoning`, `max_output_tokens`, `text`, `tool_choice` | Giữ tên và cấu trúc theo protocol của provider |
| Dữ liệu runtime | Input/messages, instructions, tools và chế độ stream | Dựng từ API Agent; không cho cấu hình provider âm thầm ghi đè dữ liệu runtime |

Trong OpenAI Responses request body, `model`, `temperature`, `reasoning`,
`max_output_tokens` là các field cùng cấp. `effort` và `summary` nằm trong
`reasoning`. `apiKey` là cấu hình xác thực; `baseURL` xác định endpoint.

### Phạm vi hỗ trợ options

- Type của các options phải dựa vào SDK chính thức, thay vì tự viết một danh
  sách con chỉ gồm temperature/effort.
- Model cụ thể có thể chỉ hỗ trợ một phần các tham số của protocol.
- Field được expose phải được adapter xử lý; không nhận rồi âm thầm bỏ qua.
- Những field liên quan đến một chế độ thực thi khác, chẳng hạn background
  hoặc conversation lưu phía provider, cần được xác định là hỗ trợ hay chưa
  hỗ trợ trước khi đưa vào public contract.
- Cập nhật SDK/type không tự chứng minh loop/codec đã hỗ trợ mọi capability
  mới của provider.

### Fault-tolerance khi provider lỗi tạm thời — đã chốt

Nhu cầu bổ sung: khi provider quá tải, bị rate limit, timeout hoặc có lỗi
kết nối tạm thời, có thể thử lại request theo cấu hình của dev. Đây là xử lý
lỗi bên provider/kết nối, không phải cơ chế retry mọi lỗi của Tessar.

Đặt `maxRetries` và `timeout` trong model/provider, thuộc cấu hình SDK/client
cùng nhóm với `apiKey` và `baseURL`:

```ts
const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-6.1-sol",
  maxRetries: 3,
  timeout: 30_000,
});
```

`maxRetries: 3` cho phép tối đa ba lần thử lại ngoài lần gọi đầu, cho một
request đủ điều kiện retry. `timeout` theo option của SDK, đơn vị milliseconds;
không được diễn giải thành tổng deadline của cả Agent loop hoặc cam kết
timeout khi stream im lặng giữa chừng.

Ranh giới thực thi đã chốt cho retry request provider:

- Tái sử dụng retry/backoff của SDK chính thức cho lỗi đủ điều kiện. Không
  thêm một lớp retry Agent tự động bên ngoài khiến số lần gọi bị nhân lên.
- Với OpenAI SDK, nhóm đủ điều kiện có lỗi kết nối, HTTP 408, 409, 429 và
  từ 500 trở lên; vẫn tôn trọng các chỉ dẫn retry mà SDK hỗ trợ.
- Lỗi cấu hình, authentication/permission, tool hoặc lỗi hệ thống Tessar
  không được gom chung rồi tự retry như lỗi provider tạm thời.
- Người dùng hủy execution phải dừng request/chờ retry, không tự thử lại.
- Không retry toàn bộ loop hoặc chạy lại các tool đã xong chỉ vì request
  model kế tiếp bị lỗi.
- Hết retry thì trả lỗi provider gốc theo contract lỗi, không đổi nó thành
  một lỗi chung của Tessar.
- Không khai báo `maxRetries`/`timeout` thì để SDK áp dụng mặc định; Tessar
  không tự ép `maxRetries: 0` hoặc một giá trị timeout khác.

Retry HTTP của SDK không đồng nghĩa tiếp tục được một stream đã ngắt giữa
chừng. Khi đã phát delta cho consumer, không tự nối một generation mới vào
delta cũ. Recovery/retry sau thời điểm này cần policy riêng để phân biệt các
attempt, tránh output trùng và bảo toàn tool/checkpoint state. Policy tự
động cho trường hợp đó chưa được chốt.

Nguồn: [OpenAI TypeScript SDK — retries và timeouts](https://developers.openai.com/api/reference/typescript),
[OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits).

## 5. Không tự thêm cấu hình mặc định

Ví dụ dev chỉ khai báo:

```ts
const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-6.1-sol",
});
```

Tessar không tự thêm `temperature`, `top_p`, reasoning effort, giới hạn output,
custom headers hoặc options khác mà dev chưa đặt. Field không khai báo để
SDK/provider xử lý mặc định theo chính sách của họ.

Không đổi tên field của provider sang một hệ field riêng của Tessar. Ví dụ
giữ `max_output_tokens` và `reasoning.effort` cho OpenAI; adapter của provider
khác expose cấu hình theo protocol của provider đó.

Nguyên tắc này áp dụng cho cấu hình model/client. Agent vẫn cần dựng dữ liệu
thực thi như messages, tool descriptions và lựa chọn streaming để chạy loop.
Nó cũng không tự hủy các giới hạn runtime đã có của Agent.

Các mặc định do OpenAI/SDK tự áp dụng không phải mặc định Tessar chèn vào.
Ví dụ `baseURL` có thể được SDK xác định khi dev không cấu hình.

## 6. Tham số đầu của stream/generate

Các hình thức input đã thống nhất:

```ts
agent.stream("Xin chào");

agent.stream(new HumanMessage("Xin chào"));

agent.stream([
  new HumanMessage("Tôi đang viết TypeScript."),
  new AssistantMessage("Bạn cần hỗ trợ phần nào?"),
  new HumanMessage("Giải thích generic giúp tôi."),
]);
```

Chuỗi được chuẩn hóa thành `HumanMessage`. Message và mảng messages tiếp tục
đi qua chuẩn message chung của Tessar. Các class message import từ
`@tessar/core`.

`generate()` nhận cùng dạng input:

```ts
const result = await agent.generate("Xin chào");
```

Không dùng lại chữ ký `agent.stream({ input: ... })` cho thiết kế mới.

Mỗi lần gọi trực tiếp là một execution độc lập. Gọi lần hai không tự nhớ
input/output của lần trước chỉ vì sử dụng cùng một instance Agent. Dev
truyền history trong mảng messages khi cần context; Session là lớp hội thoại
được bàn riêng.

## 7. Đổi tham số cho riêng một lượt

Giả sử Agent mặc định dùng `gpt-6.1-sol`, effort `high`, output limit `8192`
như ví dụ ở mục 2:

```ts
agent.stream("Trả lời ngắn thôi", {
  modelOptions: {
    reasoning: { effort: "low" },
    max_output_tokens: 2048,
  },
});
```

Lượt này giữ nguyên model/kết nối đã chọn và ghi đè các tham số được truyền.
Những field không bị ghi đè giữ cấu hình model ban đầu.

Thứ tự ưu tiên đã trao đổi:

1. `modelOptions` của lượt gọi.
2. Cấu hình của model được chọn cho lượt đó.
3. Mặc định phía SDK/provider cho các field còn bỏ trống.

`modelOptions` là options theo provider đang được chọn. Nó không chứa API key,
base URL, custom client headers hoặc các field runtime mà Agent quản lý.

Gọi tiếp:

```ts
agent.stream("Xin chào");
```

vẫn dùng effort `high` và output limit `8192` của Agent mặc định. Options của
lượt trước không được ghi ngược vào model gốc.

### Quy tắc ghi đè object đã chốt

Ghi đè theo field cấp cao nhất. Khi truyền một object mới cho field đó,
object cũ được thay nguyên giá trị; không deep merge các field bên trong.

Ví dụ cấu hình mặc định:

```ts
reasoning: { effort: "high", summary: "auto" }
```

Lượt gọi override:

```ts
modelOptions: { reasoning: { effort: "low" } }
```

thì request dùng `reasoning: { effort: "low" }`. `summary` không được kế thừa.
Những field cấp cao nhất khác không bị override, chẳng hạn
`max_output_tokens`, vẫn giữ cấu hình của model được chọn.

Quy tắc này không sửa object gốc và không ghi đè cấu hình của lượt khác.

## 8. Đổi model/provider cho riêng một lượt

### Đổi model ID trên cùng kết nối: không cần new

Với Agent mặc định dùng `gpt-6.1-sol` qua OpenAI:

```ts
agent.stream("Xin chào", {
  model: "gpt-6-astra",
});
```

Lượt này dùng `gpt-6-astra` trên cùng kết nối OpenAI: giữ API key, baseURL và
headers của model mặc định, tái sử dụng client. Các cấu hình request mặc định
được kế thừa và có thể override bằng `modelOptions`:

```ts
agent.stream("Phân tích vấn đề này", {
  model: "gpt-6-astra",
  modelOptions: {
    reasoning: { effort: "medium" },
    max_output_tokens: 4096,
  },
});
```

`generate()` hỗ trợ cùng cách dùng. Model ID thực thi và profile/trace phải
phản ánh model của lượt gọi. Model mặc định của Agent vẫn là `gpt-6.1-sol`.

Chuỗi ở `options.model` là model ID theo protocol của kết nối mặc định, không
phải yêu cầu tự tìm provider hoặc tự đổi endpoint. Model ID có dấu `/` vẫn
được giữ nguyên; không dùng tiền tố của chuỗi để tự chọn một kết nối khác.

Các field request kế thừa phải được model đích hỗ trợ. Nếu model/provider
từ chối tham số thì báo lỗi tương ứng; không tự sửa hay bỏ tham số để thử
một cấu hình khác. Field model ID được chọn qua `options.model`, không khai
báo thêm một model ID xung đột trong `modelOptions`.

### Tạo model trực tiếp tại lượt gọi

```ts
agent.stream("Phân tích đoạn code này", {
  model: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.ANTHROPIC_MODEL!,
    temperature: 0.3,
    max_tokens: 4096,
  }),
});
```

Lượt này dùng model Anthropic với cấu hình được khai báo một lần ngay trong
instance mới. Không cần thêm một `modelOptions` lặp lại các giá trị đó.

Model thay thế mang cấu hình riêng. Agent không lấy effort, output limit,
API key hoặc endpoint từ model OpenAI mặc định để trộn vào Anthropic.

### Tái sử dụng một model đã khai báo ở nơi khác

```ts
const claude = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: process.env.ANTHROPIC_MODEL!,
  max_tokens: 4096,
});

agent.stream("Phân tích đoạn code này", {
  model: claude,
  modelOptions: {
    temperature: 0.3,
  },
});
```

Ở đây `modelOptions` có ý nghĩa vì lượt gọi tái sử dụng instance có sẵn và
cần một ghi đè riêng. Dev không bắt buộc khai báo cùng một field ở hai nơi.

`generate()` có cùng cách dùng:

```ts
await agent.generate("Phân tích đoạn code này", {
  model: claude,
  modelOptions: { temperature: 0.3 },
});
```

Một Agent có thể thực thi nhiều model qua các lượt gọi. `Agent.model` vẫn
biểu thị một mặc định rõ ràng; không dùng mảng model rồi âm thầm lấy phần tử
đầu làm mặc định.

## 9. Đổi endpoint hoặc headers

Đổi model trong cùng OpenAI khác với đổi từ OpenAI sang OpenRouter. Dù
model ID tương tự, kết nối, API key, endpoint và headers có thể khác nhau.
Một chuỗi model ID không tự thay các thông tin kết nối đó.

`baseURL`, API key và headers thuộc kết nối. Khi cần kết nối khác cho một
lượt, truyền model instance mang kết nối đó:

```ts
agent.stream("Xin chào", {
  model: new OpenAIProvider({
    apiKey: process.env.OTHER_API_KEY!,
    baseURL: process.env.OTHER_BASE_URL!,
    defaultHeaders: {
      "X-App-Name": "my-app",
    },
    model: process.env.OTHER_MODEL!,
  }),
});
```

Endpoint mới phải hỗ trợ protocol mà adapter thực thi. Đổi `baseURL` không
tự chuyển một adapter Responses thành adapter cho giao thức bất kỳ.

Mỗi instance OpenAIProvider mới có `ref.connectionId` không chứa bí mật;
đổi model ID qua `withModel()` giữ cùng client và connectionId. Hai instance
mới có identity khác nhau, kể cả khi cùng tên model. Provider state chỉ được
replay trên đúng provider/model/kết nối đã tạo nó.

Khi có Controller, kết nối override được giữ trong bộ nhớ cho execution đang
tạm dừng hoặc bị gián đoạn, và được bỏ khi execution kết thúc. Identity này
chưa có cơ chế gắn lại sau khi restart process: tạo provider mới không tự
phục hồi kết nối cũ. Cơ chế khai báo và gắn lại kết nối bền vững thuộc phần
Controller/Session tiếp theo; không lưu API key hoặc client vào checkpoint.

Ví dụ chọn một kết nối OpenRouter đã khai báo riêng:

```ts
const openRouterModel = new OpenAIProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
  model: process.env.OPENROUTER_MODEL!,
});

agent.stream("Xin chào", {
  model: openRouterModel,
});
```

`OPENROUTER_MODEL` là model ID mà endpoint OpenRouter nhận. Có thể khai báo
instance này inline hoặc tái sử dụng một instance có sẵn; không bắt buộc
tạo lại cho mỗi lượt. Kết nối mặc định OpenAI của Agent giữ nguyên.

## 10. Tools, loop và kết quả thực thi

### Tools của dev gắn trực tiếp vào Agent

Hợp đồng tools đã được bàn và triển khai riêng; thiết kế model mới cần giữ
được cách dùng đó:

```ts
import { createTool } from "@tessar/core/tool";
import { z } from "zod";

const add = createTool({
  name: "add",
  description: "Cộng hai số",
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => ({ sum: a + b }),
});

const agent = new Agent({
  id: "calculator",
  model,
  tools: { add },
});
```

Tool return được chuẩn hóa thành `ToolMessage`; core tự liên kết tool call ID.
Agent gửi mô tả tool qua adapter, chạy tool khi model yêu cầu, rồi tiếp tục
loop bằng kết quả đó. Một `stream()`/`generate()` có thể gồm nhiều lần gọi
provider và nhiều tool calls.

Chi tiết schema, tool messages, concurrency và recovery tiếp tục tham chiếu
[Tools and parallel execution](2026-10-16-tessar-tools-design.md). Tài liệu
này không tự thay đổi các quyết định tools trước đó.

### Stream và generate

- `stream()` trả handle `AsyncIterable` để nhận các events chung của Tessar.
- `generate()` tiêu thụ cùng execution/loop và trả kết quả khi tới trạng thái
  kết thúc tương ứng; không có một loop triển khai riêng.
- Kết quả giữ được messages, usage và trạng thái thực thi. Shape public đầy
  đủ của kết quả cần được xác nhận ở mục 13.
- Provider chuyển stream và usage của protocol riêng về chuẩn của Tessar.
- Lỗi gốc từ SDK/provider phải giữ nguồn và danh tính lỗi trong process;
  lỗi của framework được phân biệt rõ với lỗi provider.

### Vòng đời lượt gọi đã chốt

Dev tạo Agent rồi gọi `stream()` hoặc `generate()`, không cần bao quanh bằng
`agent.initialize()`/`agent.dispose()` hoặc một bước lifecycle public khác.

```ts
const result = await agent.generate("Xin chào");
```

Mỗi execution tự chuẩn bị những gì cần để chạy loop. Khi execution hoàn
tất, lỗi hoặc bị hủy, runtime tự dọn tài nguyên nội bộ thuộc lượt đó, kể cả
các listener hoặc công việc nền gắn với execution. Việc dọn dẹp vẫn phải
được thực hiện ở các nhánh lỗi, không phụ thuộc dev viết thêm lệnh cleanup.

Một execution có thể gồm nhiều lần gọi model và tools; ranh giới dọn dẹp
là execution, không phải từng HTTP response. Agent và model có thể được tái
sử dụng cho lượt tiếp theo. Kết thúc một lượt không tự đóng các client hoặc
tài nguyên dùng chung do bên ngoài cung cấp, cũng không xóa state/checkpoint
cần giữ theo contract thực thi.

## 11. Model profile

Model instance vẫn cần expose `model.profile` theo yêu cầu đã bàn:

```ts
const model = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-6.1-sol",
});

const profile = model.profile;
```

Dev không phải tự nhập context window, capabilities hoặc pricing. SDK có
trách nhiệm lấy/resolve thông tin có nguồn gốc; dữ liệu chưa biết được biểu
diễn rõ, không đoán giá trị.

Getter đọc snapshot cache/catalog và không phát sinh request mạng.
`await model.refreshProfile()` chủ động refresh metadata qua provider.
Không cần init/dispose để dùng Agent hoặc đọc getter. Metadata không đủ
thông tin vẫn giữ trạng thái chưa biết và provenance thay vì đoán giá trị.

## 12. Ranh giới để xây tiếp Controller

Vai trò đã chốt: Agent là gốc có thể sử dụng độc lập. Controller là lớp dev
thêm khi có nhu cầu quản lý nhiều tác vụ/phiên làm việc. Tạo Agent không
đồng nghĩa phải tạo hoặc nghĩ tới Controller.

Baseline của Agent cần bảo đảm:

- Có thể tạo và chạy Agent trước khi có Controller.
- Agent luôn có model mặc định bắt buộc để chạy loop. Gọi Agent nhiều lần
  không tự làm phát sinh yêu cầu phải có Controller.
- Controller có thể dùng Agent đã tạo, không buộc dev đăng ký lại cùng
  model/kết nối để Agent thực thi.
- Model mặc định thuộc cấu hình Agent. Lựa chọn riêng của một Session không
  sửa model mặc định đó hoặc Session khác.
- Một provider/model từ plugin phải tương thích cùng hợp đồng thực thi mà
  model trực tiếp của Agent sử dụng.
- Registry và định danh không được làm mất cấu hình kết nối hoặc options khi
  thực thi lại bằng model đã chọn.

Chưa chốt lại trong tài liệu này: toàn bộ API `session.model`, cách thêm
kết nối bằng cấu hình sau đóng gói, quy tắc trùng registry và lifecycle
Controller/plugin. Những phần đó được thiết kế tiếp sau khi Agent rõ ràng.

## 13. Những điểm cần review/chốt tiếp

Các quy tắc triển khai dưới đây cụ thể hóa Agent đã chốt; phần quản lý kết
nối/plugin và API Session vẫn cần thiết kế tiếp.

| Điểm | Trạng thái triển khai / phần còn lại |
| --- | --- |
| Hợp đồng instance | Dùng ModelAdapter: ref, validate, stream; options và withModel là capability tùy adapter. OpenAIProvider có thêm profile/refreshProfile. AnthropicProvider chưa triển khai. |
| Typing của `modelOptions` | Suy ra từ model mặc định hoặc instance override; model ID string giữ type của model mặc định. Input động vẫn cần runtime validation của adapter. |
| Các field SDK/provider | OpenAI dùng type SDK chính thức; tách client options khỏi request body. Runtime sở hữu model/input/instructions/tools/stream. Background, provider-managed conversations và context_management/compaction bị từ chối rõ vì loop/codec chưa hỗ trợ. |
| Recovery stream | Retry request qua SDK và vị trí `maxRetries`/`timeout` đã chốt. Còn cần xác định policy recovery cho stream đã phát delta rồi lỗi, tránh nối output hoặc chạy lại tool không kiểm soát. |
| Continuity/history | Đã bỏ include/store mặc định. Dev phải khai báo include khi cần encrypted reasoning để replay stateless history. Adapter kiểm tra continuity theo provider/model/connection và từ chối history không tương thích. |
| Định danh kết nối/model | connectionId riêng cho mỗi client OpenAI, được giữ khi đổi ID model. Options vào checkpoint, credentials/client không vào checkpoint. Gắn lại kết nối sau restart còn thuộc Controller/Session. |
| Gắn Controller sau đó | Cầu nối tương thích đăng ký provider mặc định, dùng backend/hooks của Controller khi đã attach. Phải initialize Controller trước khi gọi qua runtime này; không đăng ký thêm cùng provider ID. API quản lý nhiều kết nối vẫn để giai đoạn sau. |
| Context/messages | Lời gọi độc lập không nối history; input nhận string/message/history. Instructions giữ hợp đồng hiện tại của core/codec. |
| Kết quả và hủy | Giữ GenerateOutcome gồm threadId, streamId, status, output, usage, interrupt và error; stream vẫn AsyncIterable có abort(). Provider exception gốc được throw từ generate; policy/framework failure vẫn theo contract outcome/event hiện tại. |
| Reuse/concurrency | Đã kiểm tra override đồng thời, options bất biến và tái sử dụng sau lỗi/abort. Cleanup đóng bộ nhớ tạm của lượt standalone, không đóng client dùng chung. |

## 14. Khác biệt với baseline trước thay đổi

Đối chiếu baseline lúc viết tài liệu với source sau triển khai:

| Nội dung | Baseline trước thay đổi | Source sau triển khai |
| --- | --- | --- |
| Thực thi Agent | Cần Controller đã initialize | Agent tự chạy được |
| Lifecycle Agent trực tiếp | Phụ thuộc lifecycle Controller | Không yêu cầu init/dispose; execution tự chuẩn bị và dọn tài nguyên của lượt gọi |
| Model trong Agent | `model` optional, kiểu `Model`/`ModelRef`; constructor lấy ref | `model` bắt buộc, nhận instance có thực thi, cấu hình và profile; model của lượt gọi chỉ override |
| OpenAI integration | `OpenAIPlugin` đăng ký provider, loop lookup theo ID | Dev có thể truyền provider instance trực tiếp |
| Chữ ký gọi | `stream({ input, ... })`, `generate({ input, ... })` | `stream(message, options?)`, `generate(message, options?)` |
| Override model ở lượt gọi | Nhận `Model`/`ModelRef`, lookup provider qua Controller | Chuỗi model ID tái sử dụng kết nối mặc định; instance khác mang cấu hình/kết nối riêng |
| Request options | Contract có `ModelRequest.options`, nhưng OpenAI adapter chưa chuyển đầy đủ | Options đi đúng đến adapter/provider |
| Defaults adapter | Ép `maxRetries: 0`, `include`, `store: false`, `stream: true` | Đã bỏ maxRetries/include/store mặc định; stream/input và instructions/tools được cấp từ runtime khi có |
| Provider packages | Có OpenAIAdapter/OpenAIPlugin | Thêm OpenAIProvider; Anthropic/Google chưa triển khai |

Source dùng để đối chiếu:

- [Agent](../../../packages/core/src/agent.ts).
- [Model contracts](../../../packages/core/src/models/contract.ts).
- [Model/profile hiện tại](../../../packages/core/src/models/profile.ts).
- [OpenAI adapter](../../../packages/openai/src/adapter.ts).
- [OpenAIProvider](../../../packages/openai/src/provider.ts).
- [Stream handle](../../../packages/core/src/engine/delivery.ts).

Kiểm tra triển khai gồm typecheck, build và test dùng SDK thật với fetch/SSE
giả lập, cùng core loop/tools/checkpoint. Chưa gọi API bằng tài khoản thật
hoặc publish thay đổi. Chi tiết kiểm chứng nằm trong
[implementation plan](../plans/2026-10-17-tessar-agent-api-plan.md).

## 15. Nguồn tham chiếu protocol

- [OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create).
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning).

Các giá trị mặc định và khả năng hỗ trợ tham số phụ thuộc model/SDK/API đang
dùng. Thiết kế của Tessar dựa vào type và tài liệu chính thức, không tự tạo
một bộ default chung rồi áp vào mọi model.
