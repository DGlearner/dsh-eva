import { expect, test, type Page } from '@playwright/test';

const password = process.env.COMPANY_WEB_LIVE_TEST_PASSWORD!;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/workbench\/tasks$/u);
}

test('manager reaches real Business API through the authenticated Gateway', async ({ page }) => {
  await login(page, 'dev_manager');

  await page.goto('/workbench/knowledge/company');
  await expect(page.getByRole('heading', { name: '公司知识', exact: true })).toBeVisible();
  await expect(page.getByText('员工报销制度', { exact: true })).toBeVisible();

  await page.goto('/workbench/requirements');
  await expect(page.getByRole('heading', { name: '需求管理', exact: true })).toBeVisible();
  await expect(page.getByText('知识检索链路验证')).toBeVisible();

  await page.goto('/workbench/tasks');
  await expect(page.getByRole('heading', { name: '任务看板', exact: true })).toBeVisible();
  await expect(page.getByText('实现日报编辑')).toBeVisible();

  await page.goto('/workbench/daily-reports/department');
  await expect(page.getByRole('heading', { name: '部门日报', exact: true })).toBeVisible();
  await expect(page.locator('article').getByText('研发成员甲', { exact: true })).toBeVisible();
});

test('member retains CSRF mutations and personal knowledge isolation', async ({ page }) => {
  await login(page, 'dev_a');

  await page.goto('/workbench/knowledge/personal');
  await expect(page.getByRole('heading', { name: '个人知识', exact: true })).toBeVisible();
  await expect(page.getByText('火星登录故障复盘', { exact: true })).toBeVisible();
  await expect(page.getByText('海洋数据迁移记录')).toHaveCount(0);

  await page.goto('/workbench/daily-reports');
  await page.getByLabel('工作日').fill('2026-08-22');
  await page.getByLabel('今日完成').fill('完成真实 Gateway 与 Business API 联调。');
  await page.getByLabel('下一步计划').fill('继续执行 integration/business 回归。');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText('日报草稿已保存。')).toBeVisible();

  await page.reload();
  await page.getByLabel('工作日').fill('2026-08-22');
  await expect(page.getByLabel('今日完成')).toHaveValue('完成真实 Gateway 与 Business API 联调。');
});
