# Storybook

This app contains the Vern component stories and runs Storybook 10 with Vite.
Its components and theme come from the `@vern/ui` workspace package.

## Run Storybook

Run from the repository root:

```sh
moon run storybook:dev
```

Storybook is available at <http://localhost:6006>. Build it with
`moon run storybook:build`.

## Storybook agent skills

To install or update the Storybook skills for an agent working in this app, run
the setup command from this directory and follow its instructions:

```sh
bunx storybook skills setup
```

Stories live beside their components in `src/stories/`. The shared preview,
global styles, and MSW handlers are in `.storybook/`.
