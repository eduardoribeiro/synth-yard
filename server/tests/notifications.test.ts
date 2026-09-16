import { add, dismiss, list } from "../notifications";

describe("notifications", () => {
  test("lists notifications newest first and dismisses by id", () => {
    const first = add("First notification");
    const second = add("Second notification");

    expect(list().slice(0, 2)).toEqual([second, first]);
    expect(dismiss(first.id)).toBe(true);
    expect(dismiss(first.id)).toBe(false);
  });
});
