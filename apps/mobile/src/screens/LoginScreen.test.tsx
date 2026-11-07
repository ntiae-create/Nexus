/**
 * @vitest-environment happy-dom
 *
 * The repository-wide config runs in `node` so backend/pkg tests stay fast; React
 * screens need a DOM, so each UI test file opts in here.
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LoginScreen } from "./LoginScreen.js";

/**
 * Tiny renderer helper: the repo has no DOM testing library, so components are
 * rendered with `react-dom/client` and queried through the DOM itself.
 */
function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const query = {
  password: (c: HTMLElement) => c.querySelector<HTMLInputElement>("#owner-password")!,
  submit: (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[type="submit"]')!,
  reveal: (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".reveal")!,
  error: (c: HTMLElement) => c.querySelector<HTMLElement>('[role="alert"]'),
  status: (c: HTMLElement) => c.querySelector<HTMLElement>('[role="status"]'),
};

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("LoginScreen", () => {
  it("has no e-mail field and requests the owner password", () => {
    const { container, unmount } = render(
      createElement(LoginScreen, { onSubmit: async () => ({ ok: true }), busy: false }),
    );

    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(query.password(container).getAttribute("type")).toBe("password");
    expect(query.password(container).autocomplete).toBe("current-password");
    unmount();
  });

  it("submits the password exactly once per interaction", async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const { container, unmount } = render(
      createElement(LoginScreen, { onSubmit, busy: false }),
    );

    setInput(query.password(container), "senha-correta");
    await act(async () => {
      query.submit(container).click();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("senha-correta");
    unmount();
  });

  it("blocks duplicate submissions while the request is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onSubmit = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    const { container, root, unmount } = render(
      createElement(LoginScreen, { onSubmit, busy: false }),
    );

    setInput(query.password(container), "senha-correta");
    // Two clicks before React can re-render as busy.
    await act(async () => {
      query.submit(container).click();
      query.submit(container).click();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    // Re-render in the busy state: the button must be disabled.
    act(() => {
      root.render(createElement(LoginScreen, { onSubmit, busy: true }));
    });
    expect(query.submit(container).disabled).toBe(true);
    unmount();
  });

  it("toggles password visibility", () => {
    const { container, unmount } = render(
      createElement(LoginScreen, { onSubmit: async () => ({ ok: true }), busy: false }),
    );

    expect(query.password(container).type).toBe("password");
    act(() => query.reveal(container).click());
    expect(query.password(container).type).toBe("text");
    expect(query.reveal(container).getAttribute("aria-pressed")).toBe("true");
    act(() => query.reveal(container).click());
    expect(query.password(container).type).toBe("password");
    unmount();
  });

  it("shows the authentication error returned by the manager and clears the field", async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, message: "Senha incorreta." }));
    const { container, unmount } = render(
      createElement(LoginScreen, { onSubmit, busy: false }),
    );

    setInput(query.password(container), "errada");
    await act(async () => {
      query.submit(container).click();
    });

    expect(query.error(container)?.textContent).toContain("Senha incorreta.");
    // The rejected password must not stay in component state.
    expect(query.password(container).value).toBe("");
    unmount();
  });

  it("warns when the password is empty instead of calling the API", async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const { container, unmount } = render(
      createElement(LoginScreen, { onSubmit, busy: false }),
    );

    await act(async () => {
      query.submit(container).click();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(query.error(container)?.textContent).toContain("Informe a senha");
    unmount();
  });

  it("shows the loading indicator and disables the form while busy", () => {
    const { container, unmount } = render(
      createElement(LoginScreen, { onSubmit: async () => ({ ok: true }), busy: true }),
    );

    expect(query.status(container)?.textContent).toContain("Entrando");
    expect(query.submit(container).disabled).toBe(true);
    expect(query.password(container).disabled).toBe(true);
    unmount();
  });

  it("explains a missing API configuration instead of attempting a login", async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const { container, unmount } = render(
      createElement(LoginScreen, {
        onSubmit,
        busy: false,
        configurationError: "Defina o endereço da API para entrar.",
      }),
    );

    expect(query.error(container)?.textContent).toContain("Defina o endereço da API");
    await act(async () => {
      query.submit(container).click();
    });
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("shows the notice explaining why the user is back at login", () => {
    const { container, unmount } = render(
      createElement(LoginScreen, {
        onSubmit: async () => ({ ok: true }),
        busy: false,
        notice: "Sua sessão expirou ou foi revogada. Entre novamente.",
      }),
    );

    expect(query.status(container)?.textContent).toContain("expirou");
    unmount();
  });
});
