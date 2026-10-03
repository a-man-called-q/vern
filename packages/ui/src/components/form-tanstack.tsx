"use client";

import {
	createFormHook,
	createFormHookContexts,
	useStore,
} from "@tanstack/react-form";
import { cn } from "cn";
import type { Label as LabelPrimitive } from "radix-ui";
import { Slot } from "radix-ui";
import * as React from "react";

import { Label } from "#components/label";

const { fieldContext, formContext, useFieldContext, useFormContext } =
	createFormHookContexts();

type FormItemContextValue = {
	id: string;
};

const FormItemContext = React.createContext<FormItemContextValue>(
	{} as FormItemContextValue,
);

function errorMessage(error: unknown) {
	if (typeof error === "string") {
		return error;
	}

	if (error && typeof error === "object" && "message" in error) {
		return String(error.message ?? "");
	}

	return undefined;
}

const useFormField = () => {
	const field = useFieldContext();
	const { id } = React.useContext(FormItemContext);
	const errors = useStore(field.store, (state) => state.meta.errors);
	const isTouched = useStore(field.store, (state) => state.meta.isTouched);
	const error = isTouched
		? errors.map(errorMessage).find((message) => message)
		: undefined;

	return {
		id,
		name: field.name,
		formItemId: `${id}-form-item`,
		formDescriptionId: `${id}-form-item-description`,
		formMessageId: `${id}-form-item-message`,
		error,
	};
};

function Form({ onSubmit, ...props }: React.ComponentProps<"form">) {
	const form = useFormContext();

	return (
		<form
			data-slot="form"
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onSubmit?.(event);
				void form.handleSubmit();
			}}
			{...props}
		/>
	);
}

function FormItem({ className, ...props }: React.ComponentProps<"div">) {
	const id = React.useId();

	return (
		<FormItemContext.Provider value={{ id }}>
			<div
				data-slot="form-item"
				className={cn("grid gap-2", className)}
				{...props}
			/>
		</FormItemContext.Provider>
	);
}

function FormLabel({
	className,
	...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
	const { error, formItemId } = useFormField();

	return (
		<Label
			data-slot="form-label"
			data-error={!!error}
			className={cn("data-[error=true]:text-destructive", className)}
			htmlFor={formItemId}
			{...props}
		/>
	);
}

function FormControl({ ...props }: React.ComponentProps<typeof Slot.Root>) {
	const { error, formItemId, formDescriptionId, formMessageId } =
		useFormField();

	return (
		<Slot.Root
			data-slot="form-control"
			id={formItemId}
			aria-describedby={
				!error
					? `${formDescriptionId}`
					: `${formDescriptionId} ${formMessageId}`
			}
			aria-invalid={!!error}
			{...props}
		/>
	);
}

function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
	const { formDescriptionId } = useFormField();

	return (
		<p
			data-slot="form-description"
			id={formDescriptionId}
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

function FormMessage({ className, ...props }: React.ComponentProps<"p">) {
	const { error, formMessageId } = useFormField();
	const body = error ?? props.children;

	if (!body) {
		return null;
	}

	return (
		<p
			data-slot="form-message"
			id={formMessageId}
			className={cn("text-sm text-destructive", className)}
			{...props}
		>
			{body}
		</p>
	);
}

const { useAppForm, withForm } = createFormHook({
	fieldContext,
	formContext,
	fieldComponents: {
		FormItem,
		FormLabel,
		FormControl,
		FormDescription,
		FormMessage,
	},
	formComponents: {
		Form,
	},
});

export {
	Form,
	FormControl,
	FormDescription,
	FormItem,
	FormLabel,
	FormMessage,
	fieldContext,
	formContext,
	useAppForm,
	useFieldContext,
	useFormContext,
	useFormField,
	withForm,
};
