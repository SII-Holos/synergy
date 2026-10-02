import os


def fixture_resources():
    return (
        {"cache_budget_gib": 10, "min_free_disk_gib": 2, "reserve_cpus": 1}
        if os.environ.get("CI") == "true"
        else {"cache_budget_gib": 384}
    )
