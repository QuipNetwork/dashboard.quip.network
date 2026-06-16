import type { Story } from "@ladle/react";
import { useState } from "react";

import { Button } from "./Button";
import { Card } from "./Card";
import { IconButton } from "./IconButton";
import { Eyebrow } from "./Label";
import { Modal } from "./Modal";
import { TextInput } from "./TextInput";

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6 bg-surface p-8 text-ink-body">{children}</div>;
}

export const Buttons: Story = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="quiet">Quiet</Button>
      <Button variant="positive">Positive</Button>
      <Button variant="danger">Danger</Button>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
      <Button disabled>Disabled</Button>
    </div>
  </Frame>
);

export const Cards: Story = () => (
  <Frame>
    <Card>
      <Eyebrow>Section label</Eyebrow>
      <h3 className="mt-2 font-display text-h4 text-ink-strong">Card heading</h3>
      <p className="mt-2 text-sm text-ink-subtle">
        Flat white surface, 1px border, sharp corners — the vault card.
      </p>
    </Card>
  </Frame>
);

export const Inputs: Story = () => {
  const [value, setValue] = useState("");
  return (
    <Frame>
      <div className="max-w-sm space-y-3">
        <Eyebrow>Search</Eyebrow>
        <TextInput value={value} onChange={setValue} placeholder="Type to search…" />
        <TextInput value="0xabc…" onChange={() => {}} mono readOnly />
      </div>
    </Frame>
  );
};

export const Labels: Story = () => (
  <Frame>
    <div className="flex flex-col gap-2">
      <Eyebrow size="xs">Extra small</Eyebrow>
      <Eyebrow size="sm">Small (default)</Eyebrow>
      <Eyebrow size="md">Medium</Eyebrow>
    </div>
  </Frame>
);

export const IconButtons: Story = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-3">
      <IconButton tone="primary" label="primary">
        <span aria-hidden>★</span>
      </IconButton>
      <IconButton tone="secondary" label="secondary">
        <span aria-hidden>★</span>
      </IconButton>
      <IconButton tone="surface" label="surface">
        <span aria-hidden>★</span>
      </IconButton>
      <IconButton tone="subtle" label="subtle">
        <span aria-hidden>★</span>
      </IconButton>
      <IconButton tone="danger" label="danger">
        <span aria-hidden>×</span>
      </IconButton>
    </div>
  </Frame>
);

export const ModalStory: Story = () => {
  const [open, setOpen] = useState(false);
  return (
    <Frame>
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      <Modal isOpen={open} onClose={() => setOpen(false)} size="md">
        <Modal.Header>Confirm action</Modal.Header>
        <Modal.Body>
          <p className="text-sm text-ink-subtle">
            Modals render flat white over a dimmed backdrop, close on Escape or backdrop click.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => setOpen(false)}>Confirm</Button>
        </Modal.Footer>
      </Modal>
    </Frame>
  );
};
