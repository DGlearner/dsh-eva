import { expect, test } from '@playwright/test';

async function expectNoPageOverflow(page: import('@playwright/test').Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.body.clientWidth,
    scrollWidth: document.body.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

const managerRoutes = [
  ['/workbench/settings/model?as=dev_manager', '模型设置'],
  ['/workbench/knowledge/company?as=dev_manager', '公司知识'],
  ['/workbench/knowledge/personal?as=dev_a', '个人知识'],
  ['/workbench/requirements?as=dev_manager', '需求管理'],
  [
    '/workbench/requirements/00000000-0000-4000-8000-000000003001?as=dev_manager',
    '知识检索链路验证',
  ],
  ['/workbench/tasks?as=dev_manager', '任务看板'],
  ['/workbench/tasks/00000000-0000-4000-8000-000000004003?as=dev_manager', '实现日报编辑'],
  ['/workbench/daily-reports?as=dev_a', '部门日报'],
  ['/workbench/daily-reports/department?as=dev_manager', '部门日报'],
] as const;

test('login supports success and credential error states', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('dev_manager');
  await page.getByLabel('密码').fill('invalid000');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('用户名或密码错误。')).toBeVisible();
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/workbench\/tasks/);
});

test('manager routes render fixture-backed content', async ({ page }) => {
  for (const [path, heading] of managerRoutes) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    await expectNoPageOverflow(page);
  }
});

test('model settings discovers and displays every model from URL and key', async ({ page }) => {
  await page.goto('/workbench/settings/model?as=dev_a');
  await page.getByLabel('API Base URL').fill('https://api.example.test/v1');
  await page.getByLabel(/API Key/u).fill('fixture-key-not-real');
  await expect(page.getByLabel('模型名称')).toHaveCount(0);

  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText(/连接成功，发现 3 个模型/u)).toBeVisible();

  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByRole('heading', { name: '已发现模型（3）' })).toBeVisible();
  await expect(page.getByText(/deepseek-chat · 默认/u)).toBeVisible();
  await expect(page.getByText('deepseek-reasoner', { exact: true })).toBeVisible();
  await expect(page.getByText('deepseek-v3.2', { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('daily report levels follow the current role and tasks open their own report', async ({
  page,
}) => {
  await page.goto('/workbench/daily-reports?as=dev_a');
  await expect(page.getByRole('button', { name: '部门日报', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '个人日报', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '公司日报', exact: true })).toHaveCount(0);

  await page.goto('/workbench/daily-reports?as=dev_manager');
  await expect(page.getByRole('button', { name: '个人日报', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '部门日报', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '公司日报', exact: true })).toHaveCount(0);

  await page.goto('/workbench/daily-reports?as=admin');
  await expect(page.getByRole('button', { name: '个人日报', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '部门日报', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '公司日报', exact: true })).toBeVisible();

  await page.goto('/workbench/tasks/00000000-0000-4000-8000-000000004002?as=dev_a');
  await page.getByRole('button', { name: '填写任务日报' }).click();
  await expect(page).toHaveURL(/task_id=00000000-0000-4000-8000-000000004002/u);
  await expect(page.getByRole('heading', { name: '任务日报', exact: true })).toBeVisible();
  await expect(page.getByText(/实现任务列表/u).first()).toBeVisible();
});

test('requirement split polls and applies the returned operation', async ({ page }) => {
  await page.goto('/workbench/requirements/00000000-0000-4000-8000-000000003001?as=dev_manager');
  await page.getByRole('button', { name: 'AI 拆分' }).click();
  await expect(page.getByText('正在生成子任务预览，请勿重复提交。')).toBeVisible();
  await expect(page.getByText(/AI 拆分(已排队|运行中)/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '拆分预览' })).toBeVisible();
  await page.getByRole('button', { name: '应用拆分' }).click();
  await expect(page.getByText('子任务草稿已应用。')).toBeVisible();
  await expect(page.getByRole('link', { name: '实现知识查询 fake' })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('task submission enters review and automation refreshes review results', async ({ page }) => {
  await page.goto('/workbench/tasks/00000000-0000-4000-8000-000000004002?as=dev_a');
  await expect(page.getByRole('button', { name: '提交审核' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '运行自动审核' })).toHaveCount(0);
  await page.getByLabel('提交说明').fill('任务列表与空状态已完成。');
  await page.getByLabel('证据说明').fill('页面检查通过。');
  await page.getByRole('button', { name: '提交结果' }).click();
  await expect(page.getByText('结果已提交，任务已进入审核。')).toBeVisible();
  await expect(page.getByText('待审核', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '运行自动审核' })).toHaveCount(0);

  await page.goto('/workbench/tasks/00000000-0000-4000-8000-000000004003?as=dev_manager');
  const summaries = page.getByText('删除后的重开场景需要人工确认。');
  await expect(summaries).toHaveCount(1);
  await page.getByRole('button', { name: '运行自动审核' }).click();
  await expect(page.getByText('正在检查最新提交，请勿重复运行。')).toBeVisible();
  await expect(page.getByText(/自动审核(已排队|运行中)/)).toBeVisible();
  await expect(page.getByText('自动审核已完成，等待主管确认。')).toBeVisible();
  await expect(summaries).toHaveCount(2);
  await expect(page.getByText('最新审核：needs_review')).toBeVisible();
  await expectNoPageOverflow(page);
});

test('automatic review entry requires a submitted review task and manager role', async ({
  page,
}) => {
  await page.goto('/workbench/tasks/00000000-0000-4000-8000-000000004001?as=dev_manager');
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '运行自动审核' })).toHaveCount(0);

  await page.goto('/workbench/tasks/00000000-0000-4000-8000-000000004002?as=dev_manager');
  await expect(page.getByText('进行中', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '运行自动审核' })).toHaveCount(0);

  await page.goto('/workbench/tasks/00000000-0000-4000-8000-000000004003?as=dev_a');
  await expect(page.getByText('待审核', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '运行自动审核' })).toHaveCount(0);

  await page.goto('/workbench/tasks/00000000-0000-4000-8000-000000004003?as=dev_manager');
  await expect(page.getByRole('button', { name: '运行自动审核' })).toBeEnabled();
  await expectNoPageOverflow(page);
});

test('daily rewrite polls and applies the returned operation', async ({ page }) => {
  await page.goto('/workbench/daily-reports?as=dev_a');
  await page.getByLabel('工作日').fill('2026-08-18');
  await expect(page.getByLabel('日报正文')).toHaveValue(/完成登录接口。/);
  await page.getByRole('button', { name: 'AI 润色' }).click();
  await expect(page.getByText('正在生成改写预览，请勿重复提交。')).toBeVisible();
  await expect(page.getByText(/日报改写(已排队|运行中)/)).toBeVisible();
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '提交日报' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除' })).toBeDisabled();
  await page.getByLabel('工作日').fill('2026-08-19');
  await page.waitForTimeout(1_200);
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toHaveCount(0);

  await page.getByLabel('工作日').fill('2026-08-18');
  await expect(page.getByLabel('日报正文')).toHaveValue(/完成登录接口。/);
  await page.getByRole('button', { name: 'AI 润色' }).click();
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'AI 润色' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '提交日报' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除' })).toBeDisabled();
  await page.getByRole('button', { name: '保留原文' }).click();
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '删除' })).toBeEnabled();

  await page.getByRole('button', { name: 'AI 润色' }).click();
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toBeVisible();
  await page.getByRole('button', { name: '应用改写' }).click();
  await expect(page.getByText('改写已应用为草稿。')).toBeVisible();
  await expect(page.getByLabel('日报正文')).toHaveValue(/完成登录接口及回归测试。/);
  await expectNoPageOverflow(page);
});

test('daily rewrite preview expires when the report revision changes', async ({ page }) => {
  await page.goto('/workbench/daily-reports?as=dev_a&mock=report-changed');
  await page.getByLabel('工作日').fill('2026-08-18');
  await expect(page.getByLabel('日报正文')).toHaveValue(/完成登录接口。/);
  await page.getByRole('button', { name: 'AI 润色' }).click();
  await expect(page.getByText('日报内容已更新，旧改写预览已失效。')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '应用改写' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除' })).toBeEnabled();
  await expectNoPageOverflow(page);
});

test('daily rewrite 412 refreshes the report and clears the stale preview', async ({ page }) => {
  await page.goto('/workbench/daily-reports?as=dev_a&mock=apply-conflict');
  await page.getByLabel('工作日').fill('2026-08-18');
  await expect(page.getByLabel('日报正文')).toHaveValue(/完成登录接口。/);
  await page.getByRole('button', { name: 'AI 润色' }).click();
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toBeVisible();

  const conflictResponse = page.waitForResponse(
    (response) => response.url().includes('/apply-rewrite') && response.status() === 412,
  );
  await page.getByRole('button', { name: '应用改写' }).click();
  await conflictResponse;
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '应用改写' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'AI 润色' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '提交日报' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '删除' })).toBeEnabled();

  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText('日报草稿已保存。')).toBeVisible();
  await expect(page.getByText('内容已被其他操作更新，请刷新后重试。')).toHaveCount(0);
  await expect(page.getByText('操作未完成')).toHaveCount(0);
  await expectNoPageOverflow(page);
});

test('automation failed and cancelled states stop with server messages', async ({ page }) => {
  await page.goto(
    '/workbench/requirements/00000000-0000-4000-8000-000000003001?as=dev_manager&mock=failed',
  );
  await page.getByRole('button', { name: 'AI 拆分' }).click();
  await expect(page.getByText('自动化处理失败。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '拆分预览' })).toHaveCount(0);

  await page.goto('/workbench/daily-reports?as=dev_a&mock=cancelled');
  await page.getByLabel('工作日').fill('2026-08-18');
  await expect(page.getByLabel('日报正文')).toHaveValue(/完成登录接口。/);
  await page.getByRole('button', { name: 'AI 润色' }).click();
  await expect(page.getByText('自动化操作已取消。')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 改写预览' })).toHaveCount(0);
});

test('admin routes enforce and render platform permissions', async ({ page }) => {
  await page.goto('/workbench/admin/users?as=admin');
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
  await expect(page.getByRole('main').getByText('平台管理员')).toBeVisible();
  await page.goto('/workbench/admin/runners?as=admin');
  await expect(page.getByRole('heading', { name: 'Runner 管理' })).toBeVisible();
  await expect(page.getByText('没有 Runner 实例')).toBeVisible();
});

test('chat route is only an official DSH handoff', async ({ page }) => {
  await page.goto('/chat?as=dev_a&chat_state=ready');
  await expect(page.getByRole('heading', { name: 'AI 对话已就绪' })).toBeVisible();
  await expect(page.getByRole('button', { name: '进入官方 DSH Web' })).toBeDisabled();
  await page.goto('/chat?as=dev_a&chat_state=failed');
  await expect(page.getByRole('heading', { name: 'Runner 启动失败' })).toBeVisible();
});

test('loading empty error forbidden and conflict states are visible', async ({ page }) => {
  await page.goto('/workbench/knowledge/company?as=dev_manager&mock=loading');
  await expect(page.getByRole('status', { name: '正在加载' })).toBeVisible();

  await page.goto('/workbench/knowledge/company?as=dev_manager&mock=empty');
  await expect(page.getByText('没有匹配的文件')).toBeVisible();

  await page.goto('/workbench/knowledge/company?as=dev_manager&mock=error');
  await expect(page.getByText('无法加载内容')).toBeVisible();

  await page.goto('/workbench/daily-reports/department?as=dev_a');
  await expect(page.getByText('访问受限')).toBeVisible();

  await page.goto('/workbench/settings/model?as=dev_a&mock=conflict');
  await page.getByLabel('API Base URL').fill('https://api.example.invalid/v1');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('内容已被其他操作更新，请刷新后重试。')).toBeVisible();
});

test('expired business requests return to login without exposing mock state', async ({ page }) => {
  await page.goto('/workbench/knowledge/company?as=dev_manager&mock=unauthorized');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
});

test('service unavailable and forbidden responses stay visible on their pages', async ({
  page,
}) => {
  await page.goto('/workbench/knowledge/company?as=dev_manager&mock=unavailable');
  await expect(page.getByRole('heading', { name: '无法加载内容' })).toBeVisible();
  await expect(page.getByText('Company API 暂时不可用，请稍后重试。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();

  await page.goto('/workbench/admin/users?as=dev_a');
  await expect(page.getByRole('heading', { name: '访问受限' })).toBeVisible();
  await expect(page.getByText('你没有权限访问此内容。')).toBeVisible();
  await expectNoPageOverflow(page);
});

test('management mutations show server 409 details', async ({ page }) => {
  await page.goto('/workbench/admin/users?as=admin');
  await page.getByRole('button', { name: '创建用户' }).click();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('显示名称').fill('重复管理员');
  await page.getByLabel('临时密码').fill('password123');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText('用户名已存在。')).toBeVisible();
  await expect(page.getByText('操作未完成')).toBeVisible();
  await expectNoPageOverflow(page);
});
