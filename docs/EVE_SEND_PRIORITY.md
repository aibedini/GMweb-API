# قرارداد GMweb برای پروژه Eve: اولویت ارسال، feeder اطلاعیه و وضعیت تحویل

این سند hand-off پیاده‌سازی Eve برای GMweb API نسخه `0.3.31` است. هدف این تغییر آن است که پیام‌های عملیاتی پشت حجم زیاد اطلاعیه‌ها نمانند، بدون اینکه ایمنی تشخیص گیرنده یا جلوگیری از ارسال تکراری ضعیف شود.

## 1. مرز مسئولیت دو سرویس

- **Eve** منبع اصلی کمپین‌ها و رکوردهای announcement است. رکوردهای زیاد را در دیتابیس خودش نگه می‌دارد، ظرفیت GMweb را می‌خواند و فقط به اندازه ظرفیت آزاد feeder می‌کند.
- **GMweb** صف اجرایی کوچک و اولویت‌بندی‌شده، مرورگر Google Messages، retry داخلی، تشخیص گیرنده و نتیجه تحویل را مدیریت می‌کند.
- Eve نباید هزاران announcement را یک‌باره به GMweb POST کند. سقف پیش‌فرض pending برای lane اطلاعیه `200` است.
- GMweb فقط یک مرورگر و یک worker دارد؛ پیام active قطع یا preempt نمی‌شود. پیام با اولویت بالاتر، بعد از پایان کار active، جلوتر از laneهای پایین‌تر اجرا می‌شود.

## 2. احراز هویت و endpointها

در همه درخواست‌ها به‌جز `/health` از project API key استفاده شود:

```http
Authorization: Bearer gmw_...
Content-Type: application/json
```

Endpointهای لازم برای Eve:

| Method | Path | کاربرد |
|---|---|---|
| `GET` | `/health` | نسخه سرویس |
| `GET` | `/ready` | آماده‌بودن Google Messages |
| `GET` | `/send/capacity` | تعداد pending هر lane و ظرفیت آزاد announcement |
| `POST` | `/send` | ثبت پیام در صف |
| `GET` | `/send/status/:requestId` | وضعیت پایدار ارسال |
| `POST` | `/send/cancel/:requestId` | لغو فقط تا قبل از active شدن |
| `GET` | `/events` | رویدادهای SSE؛ polling همچنان fallback الزامی است |

## 3. مدل چهارسطحی priority

Eve باید همیشه نام canonical را بفرستد:

| ترتیب | `priority` | `priorityLevel` | نمونه پیام |
|---:|---|---:|---|
| 1 | `critical` | 1 | خرید، تمدید اکانت، تأیید تراکنش |
| 2 | `expired` | 3 | اتمام زمانی یا حجمی |
| 3 | `expiring` | 6 | رو به اتمام زمانی یا حجمی |
| 4 | `announcement` | 10 | اطلاعیه و پیام انبوه |

قواعد صف:

- عدد کوچک‌تر زودتر اجرا می‌شود.
- داخل هر lane ترتیب **FIFO** است؛ پیام قدیمی‌تر همان lane زودتر اجرا می‌شود.
- پیام active متوقف نمی‌شود؛ priority فقط انتخاب job بعدی را تغییر می‌دهد.
- retry و defer همان priority اولیه را حفظ می‌کنند.
- اگر `priority` ارسال نشود، مقدار پیش‌فرض `expiring` است.
- برای سازگاری، `high` به `critical` و `normal` به `expiring` نگاشت می‌شوند. ورودی عددی 1 تا 10 نیز پذیرفته می‌شود، ولی Eve نباید به alias یا عدد متکی باشد.
- ساعت سکوت `02:00` تا `08:00 Asia/Tehran` است. فقط اولین تلاش تازه‌ی `critical` از آن عبور می‌کند. همه laneهای دیگر و retryهای delayed تا 08:00 نگه داشته می‌شوند.

نکته مهاجرت: jobهای قدیمی که قبلاً با `normal` ثبت شده‌اند، بعد از ارتقا `expiring` دیده می‌شوند. GMweb نمی‌تواند تشخیص دهد کدام‌یک واقعاً announcement بوده‌اند. قبل از فعال‌کردن feeder جدید، backlog قدیمی اطلاعیه باید در عملیات مهاجرت بازبینی/تخلیه شود.

## 4. ثبت پیام

درخواست:

```http
POST /send
Idempotency-Key: eve:renewal:98231:v1

{
  "to": "+989121234567",
  "text": "تمدید شما با موفقیت انجام شد.",
  "priority": "critical"
}
```

پاسخ عادی `202 Accepted`:

```json
{
  "ok": true,
  "requestId": "send_5931",
  "statusUrl": "/send/status/send_5931",
  "jobId": "6014",
  "status": "queued",
  "priority": "critical",
  "priorityLevel": 1,
  "queuePosition": 1
}
```

- Eve باید `requestId` را شناسه پایدار GMweb ذخیره کند. `jobId` داخلی است و پس از defer ممکن است عوض شود.
- `queuePosition` تقریبی است و تعداد jobهای active و هم‌سطح/پراولویت‌تر قبل از این job را نشان می‌دهد؛ تعهد زمانی نیست.
- برای هر رکورد منطقی یک `Idempotency-Key` پایدار و یکتا بفرستید. پیشنهاد: `eve:<message-kind>:<record-id>:v<content-version>`.
- retry شبکه باید دقیقاً همان key، `to` و `text` را بفرستد. استفاده دوباره از همان key با محتوای متفاوت `409 idempotency_key_reused` می‌دهد.
- پاسخ تکراری ممکن است `202` برای job در حال اجرا یا `200` برای نتیجه terminal باشد و `deduped:true` برگرداند. Eve باید همان `requestId`/`jobId` قبلی را بپذیرد و پیام جدید نسازد.
- `wait:true` برای feeder استفاده نشود؛ اتصال را تا حداکثر 90 ثانیه نگه می‌دارد و throughput را بهتر نمی‌کند.

نمونه نگاشت Eve:

```js
function gmwebPriority(kind) {
  if (["purchase", "renewal"].includes(kind)) return "critical";
  if (["time_expired", "volume_expired"].includes(kind)) return "expired";
  if (["time_expiring", "volume_expiring"].includes(kind)) return "expiring";
  if (kind === "announcement") return "announcement";
  throw new Error(`unmapped message kind: ${kind}`);
}
```

برای نوع ناشناخته fallback خودکار نگذارید؛ ثبت خطا بهتر از افتادن اشتباهی یک کمپین در lane عملیاتی است.

## 5. ظرفیت announcement

قبل از claim کردن batch جدید:

```http
GET /send/capacity
```

نمونه پاسخ:

```json
{
  "priorities": {
    "critical": 2,
    "expired": 8,
    "expiring": 19,
    "announcement": 143
  },
  "announcement": {
    "limit": 200,
    "pending": 143,
    "available": 57,
    "recommendedBatchSize": 50
  }
}
```

`pending` شامل jobهای `active`، `waiting`، `paused` و `delayed` همان lane است. فرمول batch:

```text
batchSize = min(announcement.available, announcement.recommendedBatchSize, EVE_FEEDER_BATCH_SIZE)
```

پیشنهاد production برای Eve:

- یک feeder leader فعال باشد؛ یا claim دیتابیس به‌شکل اتمیک انجام شود.
- `EVE_FEEDER_BATCH_SIZE=50` و concurrency ارسال HTTP حداکثر `5` باشد.
- وقتی `available=0` است هیچ رکوردی claim نشود و حدود 60 ثانیه بعد ظرفیت دوباره خوانده شود.
- بین batchها ظرفیت دوباره خوانده شود؛ عدد capacity یک snapshot است.

اگر بین خواندن ظرفیت و POST، صف پر شود، GMweb پاسخ زیر را با HTTP `429` و header `Retry-After: 60` می‌دهد:

```json
{
  "error": "announcement_queue_full",
  "message": "Announcement capacity is full; keep the remaining campaign rows in Eve and retry later.",
  "priority": "announcement",
  "priorityLevel": 10,
  "limit": 200,
  "pending": 200,
  "available": 0,
  "retryAfterSeconds": 60
}
```

در این حالت feeder باید متوقف شود، claimهای هنوز پذیرفته‌نشده را به حالت قابل‌ارسال برگرداند و بعد از `Retry-After` دوباره capacity بگیرد. retry همان رکورد باید همان `Idempotency-Key` را حفظ کند.

## 6. state machine پیشنهادی در Eve

حداقل فیلدها:

```text
id, recipient, body, message_kind, priority,
delivery_state, gmweb_request_id, gmweb_job_id,
idempotency_key, claim_token, claimed_at,
last_http_status, last_error, next_attempt_at,
submitted_once, verification_status,
created_at, updated_at, finished_at
```

stateهای پیشنهادی:

| Eve state | معنی |
|---|---|
| `pending` | هنوز به GMweb داده نشده |
| `claiming` | feeder این رکورد را موقتاً claim کرده |
| `queued` | GMweb آن را پذیرفته و `requestId` داریم |
| `active` | worker مرورگر در حال کار است |
| `sent` | terminal موفق |
| `unverified` | terminal نامطمئن؛ احتمال ارسال واقعی وجود دارد |
| `failed` | terminal ناموفق |
| `cancelled` | پیش از ارسال لغو شده |
| `manual_review` | وضعیت محلی برای رسیدگی انسانی به unverified |

تراکنش claim در دیتابیس Eve باید شبیه `SELECT ... FOR UPDATE SKIP LOCKED` باشد تا دو feeder یک رکورد را برندارند. رکورد `claiming` فقط وقتی `queued` شود که پاسخ معتبر `200/202` حاوی شناسه GMweb دریافت شده باشد. claimهای قدیمی بدون پاسخ باید با همان idempotency key بازیابی شوند، نه با ساخت کلید جدید.

شبه‌کد feeder:

```js
async function feedAnnouncements() {
  const cap = await gmweb.get("/send/capacity");
  const take = Math.min(cap.announcement.available, cap.announcement.recommendedBatchSize, 50);
  if (take <= 0) return scheduleAfter(60_000);

  const rows = await db.claimAnnouncementsAtomically(take);
  for (const row of rows) { // یا concurrency محدود حداکثر 5
    try {
      const response = await gmweb.post("/send", {
        to: row.recipient,
        text: row.body,
        priority: "announcement"
      }, { idempotencyKey: row.idempotency_key });

      await db.markQueued(row.id, response.requestId, response.jobId);
    } catch (error) {
      if (error.status === 429 && error.body?.error === "announcement_queue_full") {
        await db.releaseUnacceptedClaims(rowsFrom(row));
        return scheduleAfter((error.body.retryAfterSeconds || 60) * 1000);
      }
      await db.scheduleClaimRecovery(row.id); // همان Idempotency-Key
    }
  }
}
```

## 7. خواندن نتیجه و سیاست retry

```http
GET /send/status/send_5931
```

فیلدهای مهم پاسخ:

```json
{
  "requestId": "send_5931",
  "jobId": "6017",
  "status": "sent",
  "state": "completed",
  "priority": "critical",
  "priorityLevel": 1,
  "stage": "sent_after_recheck",
  "terminal": true,
  "successful": true,
  "requestedTo": "+989121234567",
  "sentTo": "+989121234567",
  "recipientEvidence": {},
  "submittedOnce": true,
  "submittedAt": "2026-08-17T12:00:00.000Z",
  "verificationStatus": "confirmed_after_recheck",
  "verificationAttempts": 2,
  "failedReason": null
}
```

نگاشت نتیجه:

| GMweb `status` | `terminal` | رفتار Eve |
|---|---:|---|
| `queued` | false | polling ادامه پیدا کند |
| `active` | false | polling ادامه پیدا کند؛ POST مجدد ممنوع |
| `sent` | true | موفق |
| `unverified` | true | **resend ممنوع**؛ `manual_review` |
| `failed` | true | مطابق سیاست کسب‌وکار بررسی/ارسال مجدد به‌عنوان درخواست جدید |
| `cancelled` | true | لغوشده |
| `suppressed` | true | duplicate مهار شده؛ نتیجه رکورد اصلی بررسی شود |

قاعده حیاتی `unverified`:

- `submittedOnce:true` یعنی GMweb یک‌بار Enter زده است.
- detector ابتدا bubble خروجی را بررسی می‌کند و سپس چند recheck فقط‌خواندنی انجام می‌دهد؛ در recheck هیچ Enter دیگری زده نمی‌شود.
- اگر bubble قابل اثبات نباشد، نتیجه `unverified` و terminal است. ممکن است پیام واقعاً روی گوشی ارسال شده باشد؛ بنابراین Eve نباید آن را به `pending` برگرداند یا خودکار resend کند.
- `verificationStatus` یکی از `confirmed_initial`، `confirmed_after_recheck` یا `manual_review_required` است.

خطای بازنشدن conversation با `unverified` فرق دارد: در خطای `CONVERSATION_OPEN_DEFER` هنوز Enter زده نشده است. GMweb آن job را یک‌بار کنار می‌گذارد و پس از 10 ارسال موفق دیگر با همان priority دوباره امتحان می‌کند. اگر بار دوم هم conversation باز نشود، `failed` terminal می‌شود. Eve در فاصله defer نباید درخواست جدید بسازد.

## 8. ایمنی conversationهای قدیمی ذخیره‌شده با نام

GMweb برای cache قدیمی مانند `Vpn Srv7 Fatemeh` به href اعتماد نمی‌کند:

1. href قدیمی فقط candidate است و هیچ اجازه‌ای برای ارسال نمی‌دهد.
2. conversation باز می‌شود، ولی هنوز متن تایپ/ارسال نمی‌شود.
3. شماره از header، details/contact info، `aria-*` یا metadata همان conversation استخراج می‌شود.
4. فقط تطابق دقیق شماره، `recipientEvidence` می‌سازد و cache را به فرمت verified ارتقا می‌دهد.
5. اگر شماره اثبات نشود، candidate رد و Start Chat با شماره اجرا می‌شود.
6. اگر همه UI attemptها پیش از Enter شکست بخورند، مسیر defer بالا اجرا می‌شود.

در پاسخ موفق، Eve می‌تواند برای audit این فیلدها را ذخیره کند: `requestedTo`، `sentTo`، `recipientEvidence` و `conversationUrl`. نبودن recipient evidence باعث fail-closed پیش از Enter می‌شود.

## 9. polling، SSE و بازیابی crash

- SSE برای سرعت UI مفید است، ولی منبع قطعی نیست؛ reconnect ممکن است eventی را از دست بدهد.
- Eve باید همه رکوردهای `queued/active` را با `requestId` poll کند؛ پیشنهاد: ابتدا هر 10 تا 15 ثانیه، سپس backoff تا 60 ثانیه.
- بعد از restart Eve، رکوردهای non-terminal از دیتابیس خوانده و status آن‌ها poll شود؛ POST مجدد فقط برای `claiming`های بدون شناسه و با همان idempotency key انجام شود.
- timeout شبکه هنگام `POST /send` به معنی رد درخواست نیست. ممکن است GMweb درخواست را پذیرفته ولی پاسخ گم شده باشد؛ همیشه همان idempotency key را retry کنید.
- HTTP `429 send_rate_limited` با `announcement_queue_full` متفاوت است، اما در هر دو حالت `Retry-After` رعایت شود.

## 10. معیار پذیرش پیاده‌سازی Eve

- چهار نوع پیام دقیقاً به چهار lane بالا نگاشت شوند.
- خرید/تمدید پشت expired، expiring یا announcement نماند.
- FIFO داخل هر lane با تست integration اثبات شود.
- Eve بیش از `available` announcement claim نکند و GMweb از 200 pending عبور نکند (با یک feeder یا claim اتمیک و concurrency محدود).
- هر پیام idempotency key پایدار داشته باشد و retry شبکه duplicate نسازد.
- `unverified` هیچ‌وقت خودکار resend نشود و وارد manual review شود.
- `requestId` ذخیره و برای polling استفاده شود؛ تغییر `jobId` در defer مشکلی ایجاد نکند.
- backlog قدیمی `normal` قبل از rollout تعیین تکلیف شود.
- قرارداد machine-readable نسخه جاری از `GET /docs/json` یا فایل `docs/openapi.json` دریافت شود.
