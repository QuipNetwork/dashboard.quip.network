// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Button } from "./Button";
import { Modal } from "./Modal";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Button", () => {
  it("renders children and fires onClick", () => {
    let clicks = 0;
    act(() => root.render(createElement(Button, { onClick: () => (clicks += 1) }, "Press me")));
    const button = container.querySelector("button")!;
    expect(button.textContent).toContain("Press me");
    act(() => button.click());
    expect(clicks).toBe(1);
  });
});

describe("Modal", () => {
  it("renders nothing when closed", () => {
    act(() =>
      root.render(
        <Modal isOpen={false} onClose={() => {}}>
          body
        </Modal>,
      ),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders the dialog when open and closes on Escape", () => {
    let closed = 0;
    act(() =>
      root.render(
        <Modal isOpen onClose={() => (closed += 1)}>
          body content
        </Modal>,
      ),
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("body content");

    const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;
    act(() => {
      window.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(1);
  });
});
