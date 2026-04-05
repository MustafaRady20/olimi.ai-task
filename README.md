# Campaign Caller simulation



### 1. Install Dependencies

```bash
npm install
```

### 2. Build the Project

```bash
npx tsc
```

---



Below is an example configuration object for running a campaign:

```js
const config = {
  customerList: ["+15550000001", "+15550000002"],

  startTime: "09:00",
  endTime: "17:00",

  maxConcurrentCalls: 3,

  maxDailyMinutes: 120,
  maxRetries: 2,
  retryDelayMs: 3_600_000, 


  timezone: "Africa/Cairo",
};
```

Production Considerations

I would prefer using BullMQ for queue and reliable retries implementation in real scenario

This simulation uses an in-process queue and retry scheduler for demonstration purposes. In a production environment, I will replace these with BullMQ for:

Durable job queues 
Reliable retries 
Concurrency control
Job visibility 