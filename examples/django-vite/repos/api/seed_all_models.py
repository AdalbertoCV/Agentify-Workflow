# Agentify: generic Django mock data. Creates a few rows of EVERY model of the project's own apps,
# filling required fields by type and resolving foreign keys over several passes.
# Run inside `manage.py shell -c "exec(open(PATH).read())"` on a throwaway database only.
import datetime
import decimal
import os
import uuid

from django.apps import apps
from django.db import models, transaction
from django.db.models import signals
from django.utils import timezone

PER_MODEL = int(os.environ.get("AGENTIFY_SEED_PER_MODEL", "3"))
MAX_PASSES = 8

# Saving must not reach queues, mail or webhooks: mute every model signal while seeding.
_muted = {}
for _sig in (signals.pre_save, signals.post_save, signals.m2m_changed, signals.pre_delete, signals.post_delete):
    _muted[_sig] = _sig.receivers
    _sig.receivers = []
    _sig.sender_receivers_cache.clear()


def _project_models():
    out = []
    for cfg in apps.get_app_configs():
        if "site-packages" in (cfg.path or "") or cfg.name.startswith("django."):
            continue
        for m in cfg.get_models():
            meta = m._meta
            if meta.abstract or meta.proxy or not meta.managed or meta.swapped:
                continue
            if m.__name__.startswith("Historical"):  # simple_history rows follow their model
                continue
            out.append(m)
    return out


def _first_choice(field):
    first = field.choices[0]
    if isinstance(first[1], (list, tuple)):  # grouped choices
        return first[1][0][0]
    return first[0]


def _value(field, model, i):
    if field.choices:
        return _first_choice(field)
    unique = field.unique
    tag = uuid.uuid4().hex[:8]
    name = model._meta.model_name
    if isinstance(field, models.EmailField):
        return f"demo{i}.{name}.{tag}@local.test"
    if isinstance(field, models.URLField):
        return f"https://example.com/{name}/{i}"
    if isinstance(field, models.SlugField):
        return f"demo-{name}-{i}-{tag}"[: field.max_length or 50]
    if isinstance(field, models.GenericIPAddressField):
        return "127.0.0.1"
    if isinstance(field, (models.CharField, models.TextField)):
        text = f"Demo {model._meta.verbose_name} {i}" + (f" {tag}" if unique else "")
        return text[: field.max_length] if field.max_length else text
    if isinstance(field, models.BooleanField):
        return False
    if isinstance(field, (models.AutoField, models.BigAutoField)):
        return None
    if isinstance(field, models.IntegerField):
        return (abs(hash(tag)) % 10_000) + i if unique else i + 1
    if isinstance(field, models.DecimalField):
        whole = max(field.max_digits - field.decimal_places, 1)
        return decimal.Decimal(min(10 ** (whole - 1), 10) if whole > 1 else 1)
    if isinstance(field, models.FloatField):
        return 1.0 + i
    if isinstance(field, models.DateTimeField):
        return timezone.now()
    if isinstance(field, models.DateField):
        return datetime.date.today()
    if isinstance(field, models.TimeField):
        return datetime.time(9, 0)
    if isinstance(field, models.DurationField):
        return datetime.timedelta(hours=1)
    if isinstance(field, models.UUIDField):
        return uuid.uuid4()
    if isinstance(field, models.JSONField):
        return {}
    if isinstance(field, models.BinaryField):
        return b""
    if isinstance(field, models.FileField):
        return f"agentify-demo/{name}-{i}.pdf"
    if field.get_internal_type() == "ArrayField":
        return []
    return None


def _snake(model, i):
    return f"demo_{model._meta.model_name}_{i}_{uuid.uuid4().hex[:6]}"


def _kwargs(model, i, nullable_fks="all", snake=False):
    """nullable_fks: "all" (fill every optional FK), "none", or the name of the only one to fill."""
    kwargs = {}
    for field in model._meta.concrete_fields:
        if field.primary_key and (field.has_default() or isinstance(field, (models.AutoField, models.BigAutoField))):
            continue
        if getattr(field, "auto_now", False) or getattr(field, "auto_now_add", False):
            continue
        if field.is_relation:
            rel = field.related_model
            if field.null:
                if nullable_fks == "all" or nullable_fks == field.name:
                    obj = rel._base_manager.order_by("?").first()
                    if obj is not None:
                        kwargs[field.name] = obj
                continue
            candidates = list(rel._base_manager.order_by("?")[:25])
            if not candidates:
                return None  # dependency not seeded yet: try in a later pass
            if isinstance(field, models.OneToOneField):
                taken = set(model._base_manager.values_list(field.attname, flat=True))
                free = [c for c in candidates if c.pk not in taken]
                if not free:
                    return None
                kwargs[field.name] = free[0]
            else:
                kwargs[field.name] = candidates[i % len(candidates)]
            continue
        if field.null or (field.has_default() and field.get_default() is not None):
            continue
        value = _value(field, model, i)
        if snake and isinstance(value, str) and not field.choices and not isinstance(field, models.FileField):
            value = _snake(model, i)[: field.max_length] if getattr(field, "max_length", None) else _snake(model, i)
        if value is not None:
            kwargs[field.name] = value
    return kwargs


def seed_all():
    pending = _project_models()
    seeded, errors = {}, {}
    for _ in range(MAX_PASSES):
        progress = False
        for model in list(pending):
            label = model._meta.label
            have = seeded.get(label, 0)
            optional_fks = [f.name for f in model._meta.concrete_fields if f.is_relation and f.null]
            # Variants for common invariants: "exactly one owner" checks and snake_case value formats.
            variants = [("all", False), ("none", False), *[(n, False) for n in optional_fks]]
            variants += [(v, True) for v, _ in variants]
            for i in range(have, PER_MODEL):
                saved = False
                for fks, snake in variants:
                    kw = _kwargs(model, i, fks, snake)
                    if kw is None:
                        break
                    try:
                        with transaction.atomic():
                            obj = model(**kw)
                            obj.save()
                        saved = True
                        break
                    except Exception as e:  # noqa: BLE001 — best effort per model
                        errors[label] = f"{type(e).__name__}: {str(e).splitlines()[0][:160]}"
                if not saved:
                    break
                seeded[label] = seeded.get(label, 0) + 1
                progress = True
            if seeded.get(label, 0) >= PER_MODEL:
                pending.remove(model)
        if not progress:
            break
    total = len(_project_models())
    print(f"mock data: {len(seeded)} de {total} modelos con filas ({sum(seeded.values())} filas)")
    for label, err in sorted(errors.items()):
        if seeded.get(label, 0) == 0:
            print(f"  sin datos {label}: {err}")


try:
    seed_all()
finally:
    for _sig, receivers in _muted.items():
        _sig.receivers = receivers
        _sig.sender_receivers_cache.clear()
